import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMarker, skillClients, SkillInstaller, type SkillClient } from './skill-installer.js';

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
  for (const client of ['llmwiki', ...skillClients]) mkdirSync(join(assets, client), { recursive: true });
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

describe('interactive POSIX skill installer', () => {
  it.each([{ args: [] }, { args: ['install'] }])('prints usage without a controlling tty for $args', async ({ args }) => {
    const execution = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn('sh', [script, ...args], {
        cwd: root, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, detached: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stderr }));
    });
    expect(execution.signal).toBeNull();
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toContain('Usage:');
    expect(execution.stderr).toContain('| sh -s -- install claude-code');
    expect(installer.status('codex', { project }).state).toBe('not-installed');
  });

  describe.skipIf(process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0)('with a controlling tty', () => {
    function interactive(answers: string, args: string[] = [], shell = 'sh') {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${shell} ${[script, ...args].map(quote).join(' ')}`;
      const execution = spawnSync('script', ['-qec', command, '/dev/null'], {
        cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home }, input: answers, timeout: 10000,
      });
      expect(execution.error).toBeUndefined();
      return { ...execution, transcript: execution.stdout + execution.stderr };
    }

    it.each(skillClients)('installs %s interactively in personal and project scopes', (client) => {
      mkdirSync(join(project, '.git'));
      const personal = interactive(`${client}\n1\n`);
      expect(personal.status, personal.transcript).toBe(0);
      expect(installer.status(client).state).toBe('current');
      const local = interactive(`${client}\n2\n${project}\n`);
      expect(local.status, local.transcript).toBe(0);
      expect(installer.status(client, { project }).state).toBe('current');
    });

    it.each(['dash', 'bash --posix'])('installs a project and skips a current install under %s', (shell) => {
      const answers = `2\n2\n${project}\n`;
      const initial = interactive(answers, [], shell);
      expect(initial.status, initial.transcript).toBe(0);
      expect(initial.transcript).toContain('"state": "current"');
      expect(initial.transcript).toContain('Separate MCP/OAuth step');
      expect(installer.status('codex', { project }).state).toBe('current');
      const current = interactive(answers, [], shell);
      expect(current.status, current.transcript).toBe(0);
      expect(current.transcript).toContain('codex: current');
      expect(current.transcript).not.toContain('"changed": true');
    });

    it('asks before overwriting modifications, defaults to no, and accepts explicit consent', () => {
      const initial = installer.install('codex', 'install', { project });
      writeFileSync(join(initial.directory, 'SKILL.md'), 'My local instructions');
      const answers = `2\n2\n${project}\n`;
      const skipped = interactive(`${answers}\n`);
      expect(skipped.status, skipped.transcript).toBe(0);
      expect(skipped.transcript).toContain('Overwrite skill files? [y/N]');
      expect(installer.status('codex', { project }).state).toBe('modified');
      const overwritten = interactive(`${answers}maybe\nyes\n`);
      expect(overwritten.status, overwritten.transcript).toBe(0);
      expect(overwritten.transcript).toContain('Answer yes or no.');
      expect(installer.status('codex', { project }).state).toBe('current');
    });

    it('automatically updates outdated installs and protects unmanaged files', () => {
      const initial = installer.install('codex', 'install', { project });
      writeFileSync(join(assets, 'version.json'), '{"version":"2.0.0"}');
      const answers = `2\n2\n${project}\n`;
      const updated = interactive(answers);
      expect(updated.status, updated.transcript).toBe(0);
      expect(updated.transcript).toContain('codex: outdated');
      expect(installer.status('codex', { project })).toMatchObject({ state: 'current', installedVersion: '2.0.0' });
      rmSync(join(initial.directory, installMarker));
      const skipped = interactive(`${answers}no\n`);
      expect(skipped.status, skipped.transcript).toBe(0);
      expect(skipped.transcript).toContain('Overwrite skill files? [y/N]');
      expect(installer.status('codex', { project }).state).toBe('unmanaged');
    });

    it('prompts only for the missing client or directory in partial commands', () => {
      const client = interactive('2\n', ['install', '--project', project]);
      expect(client.status, client.transcript).toBe(0);
      expect(client.transcript).toContain('Client [1]');
      expect(client.transcript).not.toContain('Scope:');
      expect(client.transcript).not.toContain('Project directory [');
      const directory = interactive('\n', ['install', 'codex', '--project']);
      expect(directory.status, directory.transcript).toBe(0);
      expect(directory.transcript).not.toContain('Client [1]');
      expect(directory.transcript).not.toContain('Scope:');
      expect(installer.status('codex', { project }).state).toBe('current');
    });

    it('re-prompts invalid choices and accepts empty defaults', () => {
      const execution = interactive('invalid\n\ninvalid\n\n');
      expect(execution.status, execution.transcript).toBe(0);
      expect(execution.transcript).toContain('Choose a listed client.');
      expect(execution.transcript).toContain('Choose 1 or 2.');
      expect(installer.status('claude-code').state).toBe('current');
    });

    it('requires an existing git root when choosing a Hermes project', () => {
      mkdirSync(join(project, '.git'));
      const execution = interactive(`3\n2\n${home}\n\n`);
      expect(execution.status, execution.transcript).toBe(0);
      expect(execution.transcript).toContain('Hermes projects must be a git root');
      expect(execution.transcript).toContain('Choose an existing directory');
      expect(execution.transcript).toContain('hermes skills trust');
      expect(installer.status('hermes', { project }).state).toBe('current');
    });

    it.each(['\u0004', '\u0003'])('aborts without installing on terminal EOF or interrupt (%j)', (abort) => {
      const execution = interactive(abort);
      expect(execution.status, execution.transcript).not.toBe(0);
      expect(installer.status('claude-code').state).toBe('not-installed');
      expect(installer.status('codex', { project }).state).toBe('not-installed');
    });
  });
});

describe('POSIX skill installer interoperability', () => {
  it.each(skillClients)('installs the repository bundle for %s in a project without Node', (client) => {
    const status = result('install', client, { source: repositoryScript });
    expect(status).toEqual({ ...new SkillInstaller().status(client, { project }), changed: true });
    expect(status.state).toBe('current');
  });

  it.each(skillClients)('uses HOME for %s and requires install before update', (client) => {
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
