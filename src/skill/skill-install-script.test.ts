import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMarker, SkillInstaller, type SkillClient } from './skill-installer.js';

const repositoryScript = fileURLToPath(new URL('../../skills/install.sh', import.meta.url));
let root: string;
let assets: string;
let home: string;
let project: string;
let script: string;
let installer: SkillInstaller;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'llmwiki-shell-test-'));
  assets = join(root, 'fixture assets');
  home = join(root, 'home');
  project = join(root, 'project');
  for (const client of ['llmwiki', 'claude-code', 'codex', 'hermes']) mkdirSync(join(assets, client), { recursive: true });
  mkdirSync(home);
  mkdirSync(project);
  script = join(assets, 'install.sh');
  copyFileSync(repositoryScript, script);
  writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Original skill\n\n');
  writeFileSync(join(assets, 'codex/mcp.example.toml'), 'Original example\n');
  installer = new SkillInstaller(assets, home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(action: 'install' | 'update' | 'status', client: SkillClient = 'codex', options: { force?: boolean; personal?: boolean; source?: string } = {}) {
  return spawnSync('sh', [options.source ?? script, action, client, ...(options.personal ? [] : ['--project', project]), ...(options.force ? ['--force'] : [])], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

function result(action: 'install' | 'update' | 'status', client: SkillClient = 'codex', options: Parameters<typeof run>[2] = {}) {
  const execution = run(action, client, options);
  expect(execution.error).toBeUndefined();
  expect(execution.status, execution.stderr).toBe(0);
  return JSON.parse(execution.stdout);
}

describe('POSIX skill installer interoperability', () => {
  it.each(['claude-code', 'codex', 'hermes'] as const)('installs the repository bundle for %s in a project without Node', (client) => {
    const status = result('install', client, { source: repositoryScript });
    expect(status).toEqual({ ...new SkillInstaller().status(client, { project }), changed: true });
    expect(status.state).toBe('current');
  });

  it.each(['claude-code', 'codex', 'hermes'] as const)('uses HOME for %s and requires install before update', (client) => {
    expect(result('status', client, { personal: true })).toEqual(installer.status(client));
    expect(run('update', client, { personal: true }).stderr).toMatch(/run skill install/);
    expect(result('install', client, { personal: true })).toEqual({ ...installer.status(client), changed: true });
    expect(installer.status(client).state).toBe('current');
    expect(result('update', client, { personal: true }).changed).toBe(false);
    expect(installer.status(client, { project }).state).toBe('not-installed');
  });

  it('protects a CLI-installed local edit until force and leaves a current install untouched', () => {
    const initial = installer.install('codex', 'install', { project });
    const marker = readFileSync(join(initial.directory, installMarker), 'utf8');
    writeFileSync(join(initial.directory, 'SKILL.md'), 'My local instructions');
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(run('update').stderr).toMatch(/modified.*SKILL\.md.*--force/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('My local instructions');
    expect(readFileSync(join(initial.directory, installMarker), 'utf8')).toBe(marker);
    expect(result('update', 'codex', { force: true })).toMatchObject({ state: 'current', changed: true });
    expect(installer.status('codex', { project }).state).toBe('current');
    expect(result('install').changed).toBe(false);
  });

  it('treats local deletion as a modification, even when status receives force', () => {
    const initial = installer.install('codex', 'install', { project });
    rmSync(join(initial.directory, 'SKILL.md'));
    expect(result('status', 'codex', { force: true })).toEqual(installer.status('codex', { project }));
    expect(run('update').stderr).toMatch(/SKILL\.md.*--force/);
    expect(() => readFileSync(join(initial.directory, 'SKILL.md'))).toThrow();
    result('update', 'codex', { force: true });
    expect(installer.status('codex', { project }).state).toBe('current');
  });

  it.each([false, true])('retires only formerly managed files and protects their local edits: %s', (modified) => {
    const initial = installer.install('codex', 'install', { project });
    writeFileSync(join(initial.directory, 'personal.txt'), 'Unmanaged supplement');
    if (modified) writeFileSync(join(initial.directory, 'client/mcp.example.toml'), 'My local URL');
    rmSync(join(assets, 'codex/mcp.example.toml'));
    writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Same version correction');
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(result('status').state).toBe(modified ? 'modified' : 'outdated');
    if (modified) {
      expect(run('update').stderr).toMatch(/client\/mcp\.example\.toml.*--force/);
      expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill\n\n');
    }
    result('update', 'codex', { force: modified });
    expect(() => readFileSync(join(initial.directory, 'client/mcp.example.toml'))).toThrow();
    expect(readFileSync(join(initial.directory, 'personal.txt'), 'utf8')).toBe('Unmanaged supplement');
    expect(installer.status('codex', { project })).toMatchObject({ state: 'current', installedVersion: '1.0.0' });
  });

  it('protects unmanaged collisions and never changes active configuration or unrelated files', () => {
    const directory = join(project, '.agents/skills/llmwiki');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), 'Original skill\n\n');
    writeFileSync(join(project, '.mcp.json'), 'Private active settings');
    writeFileSync(join(directory, 'personal.txt'), 'Private supplement');
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(run('install').stderr).toMatch(/unmanaged.*SKILL\.md/);
    result('install', 'codex', { force: true });
    writeFileSync(join(directory, 'client/new.txt'), 'My file');
    writeFileSync(join(assets, 'codex/new.txt'), 'New distribution file');
    writeFileSync(join(assets, 'version.json'), JSON.stringify({ version: '2.0.0' }));
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(run('update').stderr).toMatch(/client\/new\.txt/);
    result('update', 'codex', { force: true });
    expect(readFileSync(join(directory, 'client/new.txt'), 'utf8')).toBe('New distribution file');
    expect(readFileSync(join(project, '.mcp.json'), 'utf8')).toBe('Private active settings');
    expect(readFileSync(join(directory, 'personal.txt'), 'utf8')).toBe('Private supplement');
    expect(installer.status('codex', { project })).toMatchObject({ state: 'current', installedVersion: '2.0.0' });
  });

  it('reads JSON.stringify escapes and hashes exact binary bytes in both directions', () => {
    const version = 'v2 \'"; false; #\\\n한글 😀\u0000';
    const name = 'nested/quote\'"\\name\t😀\n';
    const bytes = Buffer.from([0, 255, 13, 10, 128, 10, 10]);
    mkdirSync(join(assets, 'llmwiki/nested'));
    writeFileSync(join(assets, 'llmwiki', name), bytes);
    writeFileSync(join(assets, 'version.json'), JSON.stringify({ version }));
    const initial = installer.install('codex', 'install', { project });
    const markerPath = join(initial.directory, installMarker);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    const escaped = JSON.stringify({ ...marker, ignored: [null, true, false, -1.25e3, { nested: 'value' }] })
      .replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .replaceAll('/', '\\/');
    writeFileSync(markerPath, escaped);
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(result('update').changed).toBe(false);
    writeFileSync(join(initial.directory, name), 'Local binary edit');
    expect(run('update').stderr).toMatch(/--force/);
    result('update', 'codex', { force: true });
    expect(readFileSync(join(initial.directory, name))).toEqual(bytes);
    expect(installer.status('codex', { project })).toMatchObject({ state: 'current', installedVersion: version });
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(marker);
  });

  it.each([
    '{bad json',
    JSON.stringify({ schema: 1, client: 'hermes', version: '1', files: {} }),
    JSON.stringify({ schema: 1, client: 'codex', version: '1', files: [] }),
    JSON.stringify({ schema: 1, client: 'codex', version: '', files: {} }),
    ...['../outside', 'safe\\..\\outside', '/outside', 'client//file', installMarker].map((name) =>
      JSON.stringify({ schema: 1, client: 'codex', version: '1', files: { [name]: 'a'.repeat(64) } })),
  ])('treats invalid or unsafe ownership metadata as unmanaged: %s', (invalid) => {
    const initial = installer.install('codex', 'install', { project });
    writeFileSync(join(initial.directory, installMarker), invalid);
    expect(result('status')).toEqual(installer.status('codex', { project }));
    expect(result('status').state).toBe('unmanaged');
    expect(run('update').stderr).toMatch(/unmanaged/);
    result('update', 'codex', { force: true });
    expect(installer.status('codex', { project }).state).toBe('current');
  });

  it.each(['SKILL.md', 'client', installMarker])('preflights non-file destinations or parents before any writes: %s', (name) => {
    const initial = installer.install('codex', 'install', { project });
    const path = join(initial.directory, name);
    rmSync(path, { recursive: true });
    if (name === 'client') writeFileSync(path, 'Not a directory');
    else mkdirSync(path);
    writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Updated skill');
    const execution = run('update', 'codex', { force: true });
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/non-file|non-directory/);
    if (name !== 'SKILL.md') expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill\n\n');
    if (name === 'client') expect(readFileSync(path, 'utf8')).toBe('Not a directory');
    else expect(readFileSync(join(initial.directory, 'client/mcp.example.toml'), 'utf8')).toBe('Original example\n');
  });

  it.each(['SKILL.md', 'client', installMarker])('rejects symlink destinations and parents even with force: %s', (name) => {
    const initial = installer.install('codex', 'install', { project });
    const outside = join(root, 'private');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'Private configuration');
    const path = join(initial.directory, name);
    rmSync(path, { recursive: true });
    symlinkSync(name === 'client' ? outside : join(outside, 'secret'), path);
    writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Updated skill');
    const execution = run('update', 'codex', { force: true });
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/symlink/);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('Private configuration');
    if (name !== 'SKILL.md') expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Original skill\n\n');
  });

  it('does not resolve away a symlink in the project path', () => {
    const alias = join(root, 'project alias');
    symlinkSync(project, alias);
    project = alias;
    const execution = run('install', 'codex', { force: true });
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/symlink/);
    expect(() => readFileSync(join(project, '.agents/skills/llmwiki/SKILL.md'))).toThrow();
  });
});
