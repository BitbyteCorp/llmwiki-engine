import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Command } from 'commander';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { logger } from '../log.js';
import { CatalogService } from '../rag/catalog.service.js';
import { ComparisonService } from '../rag/comparison.service.js';
import { collectStructureSignals, type StructureSignals } from './structure-signals.js';

type LintSignals = Omit<StructureSignals, 'duplicates' | 'orphans' | 'missingHubs'> & {
  duplicates: StructureSignals['duplicates'] | null;
  orphans: string[] | null;
  missingHubs: StructureSignals['missingHubs'] | null;
};

type LintReport = {
  headSha: string;
  indexedSha: string | null;
  catalog: 'current' | 'stale' | 'unavailable';
  signals: LintSignals;
};

async function inspect(): Promise<LintReport> {
  const config = loadConfig();
  const repo = await KnowledgeRepo.attachReadOnly(config, logger);
  const headSha = await repo.headSha();
  const withoutCatalog = async (): Promise<LintReport> => {
    const { signals } = await collectStructureSignals(repo,
      { graph: () => ({ nodes: [], edges: [] }) }, { duplicates: async () => [] }, headSha);
    return { headSha, indexedSha: null, catalog: 'unavailable',
      signals: { ...signals, duplicates: null, orphans: null, missingHubs: null } };
  };
  const path = join(config.dataDir, 'llmwiki.db');
  try {
    await lstat(path);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return withoutCatalog();
    }
    throw error;
  }
  // Do not use openDb/runMigrations or Nest bootstrap: both initialize persistent data.
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    // Pin all catalog/comparison reads to one SQLite snapshot, including while awaiting Git reads.
    db.exec('BEGIN');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_meta'").get()) {
      return await withoutCatalog();
    }
    const indexed = db.prepare("SELECT value FROM index_meta WHERE key = 'indexed_sha'").get() as { value: string } | undefined;
    const indexedSha = indexed?.value ?? null;
    if (indexedSha === null) return await withoutCatalog();
    const users = new UsersService(new UsersRepository(db));
    const acl = new AclService(db, users, new AuditService(db));
    const catalog = new CatalogService(db, acl);
    const comparison = new ComparisonService(config, db, logger, acl);
    const { signals } = await collectStructureSignals(repo, catalog, comparison, headSha);
    return { headSha, indexedSha, catalog: indexedSha === headSha ? 'current' : 'stale', signals };
  } finally {
    db.close();
  }
}

function humanReport(report: LintReport): string {
  const lines = [
    `Knowledge structure lint — main ${report.headSha}`,
    `Catalog: ${report.catalog} (indexed SHA: ${report.indexedSha ?? 'none'})`,
    'Read-only inspection; no initialization, reindexing or embeddings are generated.',
    'Exit 0 even when findings are present; nonzero only for errors.',
  ];
  const signals = report.signals;
  if (report.catalog !== 'current') {
    lines.push(report.catalog === 'stale'
      ? 'Index-backed duplicate, orphan and tag-hub findings use the stale indexed SHA above.'
      : 'Index-backed duplicate, orphan and tag-hub checks are unavailable (not clean).',
    'Path, domain, wikilink, metadata and size findings always use the committed main SHA above.');
  }
  lines.push('Each signal list is capped at 20 findings; only invalidMetadataCount reports the full metadata backlog.');
  const section = (label: string, findings: string[] | null) => {
    if (findings === null) {
      lines.push('', `${label} (unavailable)`);
      return;
    }
    lines.push('', `${label} (${findings.length})`);
    for (const finding of findings) lines.push(`  - ${finding}`);
  };
  section('Missing domain hubs', signals.missingDomainHubs);
  section('Unlinked domain hubs', signals.unlinkedDomainHubs);
  section('Unclassified notes', signals.unclassifiedNotes);
  section('Duplicate candidates', signals.duplicates?.map(({ left, right, reason, score }) => `${left} ↔ ${right} (${reason}, score ${score})`) ?? null);
  section('Orphan notes', signals.orphans);
  section('Unresolved wikilinks', signals.unresolved.map(({ path, target }) => `${path} → [[${target}]]`));
  section('Ambiguous wikilinks', signals.ambiguous.map(({ path, target, candidates }) => `${path} → [[${target}]]: ${candidates.join(', ')}`));
  section('Oversized folders', signals.oversizedFolders.map(({ path, count }) => `${path}: ${count} direct notes`));
  section('Oversized notes', signals.oversizedNotes.map(({ path, chars }) => `${path}: ${chars} characters`));
  section('Tiny notes', signals.tinyNotes.map(({ path, chars }) => `${path}: ${chars} body characters`));
  section('Missing tag hubs', signals.missingHubs?.map(({ tag, count, paths }) => `#${tag}: ${count} notes (${paths.join(', ')})`) ?? null);
  lines.push('', `Invalid note metadata (${signals.invalidMetadataCount}; showing ${signals.invalidMetadata.length})`);
  for (const { path, issues } of signals.invalidMetadata) {
    lines.push(`  - ${path}`);
    for (const { field, message } of issues) lines.push(`      ${field}: ${message}`);
  }
  return lines.join('\n');
}

export function registerLintCommands(program: Command): void {
  program.command('lint')
    .description('Read-only structure signals from committed main and its existing catalog; exit 0 for findings, nonzero only for errors')
    .option('--json', 'Print JSON; missing index-backed checks are null, stale checks are labeled with their indexed SHA')
    .addHelpText('after', '\nNever initializes, seeds, prunes, migrates or reindexes data and never generates embeddings.\nPath-backed checks use current main. Index-backed checks are labeled stale or unavailable when needed.')
    .action(async (options: { json?: boolean }) => {
      const report = await inspect();
      console.log(options.json ? JSON.stringify(report, null, 2) : humanReport(report));
    });
}
