import { posix } from 'node:path';
import matter from 'gray-matter';
import type { KnowledgeRepo } from '../knowledge/repo.js';
import type { CatalogService } from '../rag/catalog.service.js';
import { wikilinkTargets } from '../rag/chunking.js';
import type { ComparisonService, DuplicateNotes } from '../rag/comparison.service.js';
import { normalizeLinkTarget, NoteTargetResolver } from '../rag/link-resolver.js';

const SIGNAL_LIMIT = 20;

type Folder = { path: string; files: string[] };

export interface StructureSignals {
  duplicates: Array<{ left: string; right: string; score: number; reason: DuplicateNotes['reason'] }>;
  orphans: string[];
  unresolved: Array<{ path: string; target: string }>;
  ambiguous: Array<{ path: string; target: string; candidates: string[] }>;
  oversizedFolders: Array<Folder & { count: number }>;
  oversizedNotes: Array<{ path: string; chars: number }>;
  tinyNotes: Array<{ path: string; chars: number }>;
  missingHubs: Array<{ tag: string; count: number; paths: string[] }>;
}

function wikiNote(path: string): boolean {
  return path.startsWith('wiki/') && /\.md$/i.test(path);
}

function folderFor(path: string): string {
  return `${posix.dirname(path)}/`;
}

/** Catalog and comparison calls deliberately use their unrestricted system view. */
export async function collectStructureSignals(
  repo: KnowledgeRepo,
  catalog: CatalogService,
  comparison: ComparisonService,
  sha: string,
): Promise<{ signals: StructureSignals; folders: Folder[] }> {
  const files = (await repo.diffNames(null, sha)).map(({ path }) => path).sort();
  const wikiFiles = files.filter(wikiNote);
  const wikiPaths = new Set(wikiFiles);
  const noteResolver = new NoteTargetResolver(files.filter((path) => /\.md$/i.test(path)));
  const fileResolver = new NoteTargetResolver(files);
  const graph = catalog.graph();
  const incoming = new Set(graph.edges.map(({ to }) => to));
  const outgoing = new Map<string, Set<string>>();
  for (const { from, to } of graph.edges) {
    if (!wikiPaths.has(from) || !wikiPaths.has(to)) continue;
    const targets = outgoing.get(from);
    if (targets) targets.add(to);
    else outgoing.set(from, new Set([to]));
  }

  const folderFiles = new Map<string, string[]>();
  for (const path of wikiFiles) {
    const folder = folderFor(path);
    const direct = folderFiles.get(folder);
    if (direct) direct.push(path);
    else folderFiles.set(folder, [path]);
  }
  const folders = [...folderFiles].sort(([left], [right]) => comparePath(left, right))
    .map(([path, direct]) => ({ path, files: direct }));
  const signals: StructureSignals = {
    duplicates: (await comparison.duplicates(SIGNAL_LIMIT))
      .filter(({ left, right }) => wikiPaths.has(left.path) && wikiPaths.has(right.path))
      .slice(0, SIGNAL_LIMIT)
      .map(({ left, right, score, reason }) => ({ left: left.path, right: right.path, score, reason })),
    orphans: wikiFiles.filter((path) => !incoming.has(path)).slice(0, SIGNAL_LIMIT),
    unresolved: [],
    ambiguous: [],
    oversizedFolders: folders.filter(({ files: direct }) => direct.length > 30).slice(0, SIGNAL_LIMIT)
      .map(({ path, files: direct }) => ({ path, count: direct.length, files: direct.slice(0, SIGNAL_LIMIT) })),
    oversizedNotes: [],
    tinyNotes: [],
    missingHubs: [],
  };

  for (const path of wikiFiles) {
    const markdown = await repo.readFile(path, sha);
    if (markdown === null) continue;
    if (markdown.length > 20_000 && signals.oversizedNotes.length < SIGNAL_LIMIT) {
      signals.oversizedNotes.push({ path, chars: markdown.length });
    }
    const bodyChars = matter(markdown).content.trim().length;
    if (bodyChars < 200 && signals.tinyNotes.length < SIGNAL_LIMIT) {
      signals.tinyNotes.push({ path, chars: bodyChars });
    }
    for (const { text } of wikilinkTargets(markdown)) {
      const extension = posix.extname(text).toLowerCase();
      const resolver = extension && extension !== '.md' ? fileResolver : noteResolver;
      const target = resolver.resolve(text);
      if (target.path !== null) continue;
      if (target.candidates.length > 1) {
        if (signals.ambiguous.length < SIGNAL_LIMIT) {
          signals.ambiguous.push({ path, target: text, candidates: target.candidates.slice(0, SIGNAL_LIMIT) });
        }
      } else if (signals.unresolved.length < SIGNAL_LIMIT) {
        signals.unresolved.push({ path, target: text });
      }
    }
  }

  const taggedPaths = new Map<string, Set<string>>();
  for (const { path, tags } of graph.nodes) {
    if (!wikiPaths.has(path)) continue;
    for (const tag of tags) {
      const tagged = taggedPaths.get(tag);
      if (tagged) tagged.add(path);
      else taggedPaths.set(tag, new Set([path]));
    }
  }
  for (const [tag, tagged] of [...taggedPaths].sort(([left], [right]) => comparePath(left, right))) {
    if (tagged.size < 5) continue;
    const threshold = Math.ceil(tagged.size / 2);
    const hasHub = [...outgoing.values()].some((targets) => {
      let coverage = 0;
      for (const target of targets) {
        if (tagged.has(target) && ++coverage >= threshold) return true;
      }
      return false;
    });
    if (!hasHub && signals.missingHubs.length < SIGNAL_LIMIT) {
      signals.missingHubs.push({ tag, count: tagged.size, paths: [...tagged].sort().slice(0, SIGNAL_LIMIT) });
    }
  }
  return { signals, folders };
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectDreamMode(
  signals: StructureSignals,
  hasChanges: boolean,
  folders: Folder[],
  lastSweeps: ReadonlyMap<string, string>,
): { mode: 'local' | 'structural' | 'sweep' | null; focus: string | null } {
  if (signals.duplicates.length || signals.orphans.length >= 5 || signals.oversizedFolders.length
    || signals.ambiguous.length || signals.unresolved.length >= 5 || signals.missingHubs.length) {
    return { mode: 'structural', focus: null };
  }
  if (hasChanges) return { mode: 'local', focus: null };
  let selected: string | null = null;
  for (const { path, files } of folders) {
    if (!path.startsWith('wiki/') || !files.some((file) => wikiNote(file) && folderFor(file) === path)) continue;
    if (selected === null) {
      selected = path;
      continue;
    }
    const previous = lastSweeps.get(selected);
    const current = lastSweeps.get(path);
    if ((current === undefined && previous !== undefined)
      || (current !== undefined && previous !== undefined && current < previous)
      || (current === previous && comparePath(path, selected) < 0)) selected = path;
  }
  return selected === null ? { mode: null, focus: null } : { mode: 'sweep', focus: selected };
}

/** Folder scopes contain direct notes only, matching sweep inventory rather than subtrees. */
export function restrictStructureSignals(signals: StructureSignals, paths: string[], folders: string[] = []): StructureSignals {
  const selectedPaths = new Set(paths);
  const selectedFolders = new Set(folders.map((folder) => folder.endsWith('/') ? folder : `${folder}/`));
  const changedTargets = new NoteTargetResolver(paths.filter(wikiNote));
  const normalizedFolders = new Set([...selectedFolders].map((folder) => folder.toLowerCase()));
  const touches = (path: string): boolean => selectedPaths.has(path) || selectedFolders.has(folderFor(path));
  const touchesFolder = (path: string): boolean => selectedFolders.has(path)
    || paths.some((changed) => folderFor(changed) === path);
  const touchesTarget = (target: string): boolean => changedTargets.resolve(target).candidates.length > 0
    || normalizedFolders.has(folderFor(`${normalizeLinkTarget(target)}.md`));
  return {
    duplicates: signals.duplicates.filter(({ left, right }) => touches(left) || touches(right)).slice(0, SIGNAL_LIMIT),
    orphans: signals.orphans.filter(touches).slice(0, SIGNAL_LIMIT),
    unresolved: signals.unresolved.filter(({ path, target }) => touches(path) || touchesTarget(target)).slice(0, SIGNAL_LIMIT),
    ambiguous: signals.ambiguous.filter(({ path, target, candidates }) => touches(path) || touchesTarget(target) || candidates.some(touches))
      .slice(0, SIGNAL_LIMIT).map((signal) => ({ ...signal, candidates: signal.candidates.slice(0, SIGNAL_LIMIT) })),
    oversizedFolders: signals.oversizedFolders.filter(({ path }) => touchesFolder(path)).slice(0, SIGNAL_LIMIT)
      .map((signal) => ({ ...signal, files: signal.files.slice(0, SIGNAL_LIMIT) })),
    oversizedNotes: signals.oversizedNotes.filter(({ path }) => touches(path)).slice(0, SIGNAL_LIMIT),
    tinyNotes: signals.tinyNotes.filter(({ path }) => touches(path)).slice(0, SIGNAL_LIMIT),
    missingHubs: signals.missingHubs.filter(({ paths: tagged }) => tagged.some(touches)).slice(0, SIGNAL_LIMIT)
      .map((signal) => ({ ...signal, paths: signal.paths.slice(0, SIGNAL_LIMIT) })),
  };
}
