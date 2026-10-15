import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  for (const client of ['llmwiki', ...skillClients]) mkdirSync(join(assets, client), { recursive: true });
  writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(assets, 'llmwiki', 'SKILL.md'), 'Original skill');
  writeFileSync(join(assets, 'codex', 'mcp.example.toml'), 'Original example');
  installer = new SkillInstaller(assets, home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function upgrade(): void {
  writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '2.0.0' }));
  writeFileSync(join(assets, 'llmwiki', 'SKILL.md'), 'Updated skill');
  writeFileSync(join(assets, 'codex', 'mcp.example.toml'), 'Updated example');
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
    expect(readFileSync(join(initial.directory, 'client/mcp.example.toml'), 'utf8')).toBe('Updated example');
    expect(readFileSync(join(initial.directory, 'personal.txt'), 'utf8')).toBe('Private supplement');
    expect(installer.install('codex', 'update').changed).toBe(false);
  });

  it('preflights every file and refuses a partial upgrade when a client example is modified', () => {
    const initial = installer.install('codex', 'install');
    const marker = readFileSync(join(initial.directory, installMarker), 'utf8');
    writeFileSync(join(initial.directory, 'client/mcp.example.toml'), 'My custom URL');
    upgrade();
    expect(installer.status('codex')).toMatchObject({ state: 'modified', modifiedFiles: ['client/mcp.example.toml'] });
    expect(() => installer.install('codex', 'update')).toThrow(/--force/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    expect(readFileSync(join(initial.directory, installMarker), 'utf8')).toBe(marker);
    expect(readFileSync(join(initial.directory, 'client/mcp.example.toml'), 'utf8')).toBe('My custom URL');
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
    writeFileSync(join(initial.directory, 'client/new.txt'), 'My file');
    writeFileSync(join(assets, 'codex/new.txt'), 'Distribution file');
    upgrade();
    expect(installer.status('codex')).toMatchObject({ state: 'unmanaged', unmanagedFiles: ['client/new.txt'] });
    expect(() => installer.install('codex', 'update')).toThrow(/client\/new.txt/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill');
    installer.install('codex', 'update', { force: true });
    expect(readFileSync(join(initial.directory, 'client/new.txt'), 'utf8')).toBe('Distribution file');
  });

  it('detects changed assets at the same version and safely retires formerly managed files', () => {
    const initial = installer.install('codex', 'install');
    writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Same version correction');
    rmSync(join(assets, 'codex/mcp.example.toml'));
    expect(installer.status('codex').state).toBe('outdated');
    installer.install('codex', 'update');
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Same version correction');
    expect(() => readFileSync(join(initial.directory, 'client/mcp.example.toml'))).toThrow();
    expect(installer.status('codex')).toMatchObject({ state: 'current', installedVersion: '1.0.0' });
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
