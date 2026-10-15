import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMarker, skillClients, SkillInstaller } from './skill-installer.js';

let root: string;
let assets: string;
let home: string;
let installer: SkillInstaller;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'llmwiki-skill-test-'));
  assets = join(root, 'assets');
  home = join(root, 'home');
  mkdirSync(join(assets, 'llmwiki/references'), { recursive: true });
  writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(assets, 'llmwiki', 'SKILL.md'), 'Original skill');
  writeFileSync(join(assets, 'llmwiki/references/usage.txt'), 'Original usage');
  installer = new SkillInstaller(assets, home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function upgrade(): void {
  writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '2.0.0' }));
  writeFileSync(join(assets, 'llmwiki', 'SKILL.md'), 'Updated skill');
  writeFileSync(join(assets, 'llmwiki/references/usage.txt'), 'Updated usage');
}

describe('skill installation ownership and versions', () => {
  it('refuses even byte-identical preexisting unmanaged files until forced', () => {
    const directory = join(home, '.agents/skills/llmwiki');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), 'Original skill');
    expect(installer.status('codex')).toMatchObject({ state: 'unmanaged', installedVersion: null, unmanagedFiles: ['SKILL.md'] });
    expect(() => installer.install('codex', 'install')).toThrow(/unmanaged.*SKILL.md/);
    expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    expect(() => readFileSync(join(directory, installMarker))).toThrow();
    expect(installer.install('codex', 'install', { force: true })).toMatchObject({ state: 'current', installedVersion: '1.0.0' });
  });

  it('reports and upgrades an unmodified old version without touching unrelated files', () => {
    expect(installer.status('codex').state).toBe('not-installed');
    const initial = installer.install('codex', 'install');
    writeFileSync(join(initial.directory, 'personal.txt'), 'Private supplement');
    upgrade();
    expect(installer.status('codex')).toMatchObject({ state: 'outdated', installedVersion: '1.0.0', availableVersion: '2.0.0', modifiedFiles: [] });
    expect(installer.install('codex', 'update')).toMatchObject({ state: 'current', installedVersion: '2.0.0', changed: true });
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Updated skill');
    expect(readFileSync(join(initial.directory, 'references/usage.txt'), 'utf8')).toBe('Updated usage');
    expect(readFileSync(join(initial.directory, 'personal.txt'), 'utf8')).toBe('Private supplement');
    expect(installer.install('codex', 'update').changed).toBe(false);
  });

  it('preflights every file and refuses a partial upgrade when a canonical reference is modified', () => {
    const initial = installer.install('codex', 'install');
    const marker = readFileSync(join(initial.directory, installMarker), 'utf8');
    writeFileSync(join(initial.directory, 'references/usage.txt'), 'My custom instructions');
    upgrade();
    expect(installer.status('codex')).toMatchObject({ state: 'modified', modifiedFiles: ['references/usage.txt'] });
    expect(() => installer.install('codex', 'update')).toThrow(/--force/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    expect(readFileSync(join(initial.directory, installMarker), 'utf8')).toBe(marker);
    expect(readFileSync(join(initial.directory, 'references/usage.txt'), 'utf8')).toBe('My custom instructions');
    expect(installer.install('codex', 'update', { force: true }).state).toBe('current');
  });

  it('treats deleted managed files as local modifications rather than silently restoring them', () => {
    const initial = installer.install('codex', 'install');
    rmSync(join(initial.directory, 'SKILL.md'));
    expect(installer.status('codex')).toMatchObject({ state: 'modified', modifiedFiles: ['SKILL.md'] });
    expect(() => installer.install('codex', 'update')).toThrow(/SKILL.md/);
    installer.install('codex', 'update', { force: true });
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
  });

  it('protects unmanaged collisions introduced by new versions', () => {
    const initial = installer.install('codex', 'install');
    writeFileSync(join(initial.directory, 'references/new.txt'), 'My file');
    writeFileSync(join(assets, 'llmwiki/references/new.txt'), 'Distribution file');
    upgrade();
    expect(installer.status('codex')).toMatchObject({ state: 'unmanaged', unmanagedFiles: ['references/new.txt'] });
    expect(() => installer.install('codex', 'update')).toThrow(/references\/new.txt/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    installer.install('codex', 'update', { force: true });
    expect(readFileSync(join(initial.directory, 'references/new.txt'), 'utf8')).toBe('Distribution file');
  });

  it('detects changed assets at the same version and safely retires formerly managed files', () => {
    const initial = installer.install('codex', 'install');
    writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Same version correction');
    rmSync(join(assets, 'llmwiki/references/usage.txt'));
    expect(installer.status('codex').state).toBe('outdated');
    installer.install('codex', 'update');
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Same version correction');
    expect(() => readFileSync(join(initial.directory, 'references/usage.txt'))).toThrow();
    expect(installer.status('codex')).toMatchObject({ state: 'current', installedVersion: '1.0.0' });
  });

  it.each([
    { name: 'client/README.md', action: 'install' },
    { name: 'client/README.md', action: 'update' },
    { name: 'client/mcp.example.toml', action: 'install' },
    { name: 'client/mcp.example.toml', action: 'update' },
  ] as const)('retires legacy managed $name with $action while preserving unmanaged extras and protecting edits', ({ name, action }) => {
    const initial = installer.install('codex', 'install');
    const markerPath = join(initial.directory, installMarker);
    const canonicalMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    const legacyContent = 'Previously distributed client setup';
    const legacyMarker = { ...canonicalMarker, version: '0.3.0', files: { ...canonicalMarker.files,
      [name]: createHash('sha256').update(legacyContent).digest('hex') } };
    mkdirSync(join(initial.directory, 'client'));
    writeFileSync(join(initial.directory, name), legacyContent);
    writeFileSync(join(initial.directory, 'client/personal.txt'), 'Private supplement');
    writeFileSync(markerPath, JSON.stringify(legacyMarker));
    expect(installer.status('codex').state).toBe('outdated');
    expect(installer.install('codex', action)).toMatchObject({ state: 'current', changed: true });
    expect(existsSync(join(initial.directory, name))).toBe(false);
    expect(readFileSync(join(initial.directory, 'client/personal.txt'), 'utf8')).toBe('Private supplement');
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(canonicalMarker);

    writeFileSync(join(initial.directory, name), 'Locally edited setup');
    const previousMarker = JSON.stringify(legacyMarker);
    writeFileSync(markerPath, previousMarker);
    expect(installer.status('codex')).toMatchObject({ state: 'modified', modifiedFiles: [name] });
    expect(() => installer.install('codex', action)).toThrow(/--force/);
    expect(readFileSync(markerPath, 'utf8')).toBe(previousMarker);
    expect(readFileSync(join(initial.directory, name), 'utf8')).toBe('Locally edited setup');
    expect(installer.install('codex', action, { force: true })).toMatchObject({ state: 'current', changed: true });
    expect(existsSync(join(initial.directory, name))).toBe(false);
    expect(readFileSync(join(initial.directory, 'client/personal.txt'), 'utf8')).toBe('Private supplement');
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(canonicalMarker);
  });

  it.each(skillClients)('loads only recursive canonical assets for %s, ignoring client setup directories', (client) => {
    mkdirSync(join(assets, client), { recursive: true });
    writeFileSync(join(assets, client, 'README.md'), 'Installation-only guide');
    const result = installer.install(client, 'install');
    expect(result.state).toBe('current');
    expect(readFileSync(join(result.directory, 'references/usage.txt'), 'utf8')).toBe('Original usage');
    expect(existsSync(join(result.directory, 'client'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(result.directory, installMarker), 'utf8')).files).sort())
      .toEqual(['SKILL.md', 'references/usage.txt']);
  });

  it.each([
    ['claude-code', '.claude'], ['codex', '.agents'], ['hermes', '.hermes'],
    ['cline', '.cline'], ['kiro', '.kiro'], ['qwen-code', '.qwen'],
  ] as const)('installs %s in a project while preserving active config and secrets even with force', (client, clientRoot) => {
    const project = join(root, 'project');
    mkdirSync(join(project, '.codex'), { recursive: true });
    mkdirSync(join(project, '.hermes'), { recursive: true });
    writeFileSync(join(project, '.codex/config.toml'), 'user token and settings');
    writeFileSync(join(project, '.hermes/config.yaml'), 'user secret and settings');
    writeFileSync(join(project, '.mcp.json'), 'user MCP settings');
    const result = installer.install(client, 'install', { project, force: true });
    expect(result.directory).toBe(join(project, clientRoot, 'skills/llmwiki'));
    expect(readFileSync(join(result.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    expect(readFileSync(join(project, '.codex/config.toml'), 'utf8')).toBe('user token and settings');
    expect(readFileSync(join(project, '.hermes/config.yaml'), 'utf8')).toBe('user secret and settings');
    expect(readFileSync(join(project, '.mcp.json'), 'utf8')).toBe('user MCP settings');
    expect(installer.status(client).state).toBe('not-installed');
  });

  it('never follows a symlink to configuration, including with force', () => {
    const initial = installer.install('codex', 'install');
    const secret = join(root, 'secret-config');
    writeFileSync(secret, 'private');
    rmSync(join(initial.directory, 'SKILL.md'));
    symlinkSync(secret, join(initial.directory, 'SKILL.md'));
    expect(() => installer.install('codex', 'update', { force: true })).toThrow(/symlink/);
    expect(readFileSync(secret, 'utf8')).toBe('private');
  });

  it('requires install before update and rejects invalid ownership markers without force', () => {
    expect(() => installer.install('codex', 'update')).toThrow(/run skill install/);
    const initial = installer.install('codex', 'install');
    writeFileSync(join(initial.directory, installMarker), '{bad json');
    expect(installer.status('codex').state).toBe('unmanaged');
    expect(() => installer.install('codex', 'update')).toThrow(/unmanaged/);
    expect(installer.install('codex', 'update', { force: true }).state).toBe('current');
  });
});
