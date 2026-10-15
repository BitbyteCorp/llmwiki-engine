import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../common/tokens.js';
import { SkillModule } from './skill.module.js';
import { SKILL_ASSETS } from './skill-distribution.service.js';
import { skillClients, SkillInstaller } from './skill-installer.js';

const execute = promisify(execFile);
let app: INestApplication;
let root: string;
let assets: string;
let url: string;
let fault: 'corrupt' | 'unavailable' | null;
const config = { publicUrl: 'https://wiki.example.com/base///' };

@Global()
@Module({ providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] })
class DistributionConfigModule {}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'llmwiki-distribution-'));
  assets = join(root, 'assets');
  for (const name of ['llmwiki', ...skillClients]) mkdirSync(join(assets, name), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../../skills/install.sh', import.meta.url)), join(assets, 'install.sh'));
  writeFileSync(join(assets, 'version.json'), '{"version":"fixture-1"}');
  writeFileSync(join(assets, 'llmwiki/SKILL.md'), 'Skill without a trailing newline');
  writeFileSync(join(assets, 'codex/binary.dat'), Buffer.from([0, 255, 10, 128]));
  const module = await Test.createTestingModule({ imports: [DistributionConfigModule, SkillModule] })
    .overrideProvider(SKILL_ASSETS).useValue(assets)
    .compile();
  app = module.createNestApplication({ logger: false });
  fault = null;
  let fileRequests = 0;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (fault && req.path.startsWith('/skills/files/') && ++fileRequests === 2) {
      res.status(fault === 'unavailable' ? 503 : 200).send('Corrupted transport bytes');
    } else next();
  });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});
afterEach(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

describe('public skill distribution', () => {
  it('serves the canonical script publicly with configured URL, never the request Host', async () => {
    const response = await request(app.getHttpServer()).get('/skills/install.sh').set('Host', 'attacker.example').expect(200);
    expect(response.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.text).toContain("engine_url='https://wiki.example.com/base'");
    expect(response.text).not.toContain('attacker.example');
    expect(response.text.replace("engine_url='https://wiki.example.com/base'", "engine_url=''")).toBe(readFileSync(join(assets, 'install.sh'), 'utf8'));
  });

  it.each(['/skills/files/../../package.json', '/skills/files/%2e%2e%2fpackage.json', '/skills/files/%252e%252e%252fpackage.json', '/skills/files/install.sh', '/skills/version.json/../package.json', '/skills/manifest/unknown', '/skills/package.json'])('rejects non-distributed paths: %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(404);
  });
  it.each(skillClients)('publishes a remotely installable manifest for %s', async (client) => {
    const project = join(root, 'client project');
    const home = join(root, 'client home');
    const result = await execute('sh', ['-c', 'curl -fsSL "$SOURCE/skills/install.sh" | HOME="$TARGET_HOME" LLMWIKI_URL="$SOURCE" sh -s -- install "$CLIENT" --project "$PROJECT"'], {
      cwd: root, env: { ...process.env, SOURCE: url, TARGET_HOME: home, PROJECT: project, CLIENT: client },
    });
    expect(JSON.parse(result.stdout).state).toBe('current');
    expect(new SkillInstaller(assets, home).status(client, { project }).state).toBe('current');
  });


  it('downloads over HTTP from a curl pipe and interoperates byte-for-byte with CLI installs', async () => {
    const project = join(root, 'project');
    const home = join(root, 'home');
    const result = await execute('sh', ['-c', 'curl -fsSL "$SOURCE/skills/install.sh" | HOME="$TARGET_HOME" LLMWIKI_URL="$SOURCE" sh -s -- install codex --project "$PROJECT"'], {
      cwd: root, env: { ...process.env, SOURCE: url, TARGET_HOME: home, PROJECT: project },
    });
    expect(JSON.parse(result.stdout).state).toBe('current');
    expect(result.stderr).toContain('Separate MCP/OAuth step');
    const installer = new SkillInstaller(assets, home);
    expect(installer.status('codex', { project }).state).toBe('current');
    const installed = join(project, '.agents/skills/llmwiki');
    const expected = installer.install('codex', 'install', { project: join(root, 'cli') });
    for (const name of ['SKILL.md', 'client/binary.dat', '.llmwiki-install.json']) {
      expect(readFileSync(join(installed, name))).toEqual(readFileSync(join(expected.directory, name)));
    }
  });

  it.skipIf(process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0)('reads interactive curl-pipe answers from the terminal, not script stdin', async () => {
    const project = join(root, 'interactive project');
    const home = join(root, 'interactive home');
    mkdirSync(project);
    mkdirSync(home);
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile('script', ['-qec', 'curl -fsSL "$SOURCE/skills/install.sh" | sh', '/dev/null'], {
        cwd: project, env: { ...process.env, HOME: home, SOURCE: url, LLMWIKI_URL: url }, timeout: 10000,
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin!.end(`2\n2\n${project}\n`);
    });
    expect(result.stdout).toContain('"state": "current"');
    expect(result.stdout).toContain('Separate MCP/OAuth step');
    expect(new SkillInstaller(assets, home).status('codex', { project }).state).toBe('current');
  });

  it.each([
    ['dash', ['-s', '--']],
    ['bash', ['--posix', '-s', '--']],
    ...(spawnSync('busybox', ['sh', '-c', ':']).status === 0 ? [['busybox', ['sh', '-s', '--']]] : []),
  ] as [string, string[]][])('installs from stdin under %s', async (shell, flags) => {
    const project = join(root, 'portable');
    const script = await (await fetch(`${url}/skills/install.sh`)).text();
    const child = execFile(shell, [...flags, 'install', 'codex', '--project', project], {
      cwd: root, env: { ...process.env, HOME: root, LLMWIKI_URL: url },
    });
    child.stdin!.end(script);
    const result = await new Promise<string>((resolve, reject) => {
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    expect(JSON.parse(result).state).toBe('current');
    expect(new SkillInstaller(assets, root).status('codex', { project }).state).toBe('current');
  });

  it.each(['corrupt', 'unavailable'] as const)('leaves an existing installation unchanged on %s downloads', async (failure) => {
    const project = join(root, 'project');
    const installer = new SkillInstaller(assets, root);
    const initial = installer.install('codex', 'install', { project });
    const before = readFileSync(join(initial.directory, '.llmwiki-install.json'));
    writeFileSync(join(initial.directory, 'SKILL.md'), 'Local instructions');
    fault = failure;
    await expect(execute('sh', ['-c', 'curl -fsSL \"$SOURCE/skills/install.sh\" | LLMWIKI_URL=\"$SOURCE\" sh -s -- update codex --project \"$PROJECT\" --force'], {
      cwd: root, env: { ...process.env, SOURCE: url, PROJECT: project },
    })).rejects.toThrow(failure === 'corrupt' ? /SHA-256 mismatch/ : /Cannot download skill asset/);
    expect(readFileSync(join(initial.directory, 'SKILL.md'), 'utf8')).toBe('Local instructions');
    expect(readFileSync(join(initial.directory, '.llmwiki-install.json'))).toEqual(before);
  });

  it('installs using only the PUBLIC_URL embedded by the app on a random port', async () => {
    const handler = express();
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const source = `http://127.0.0.1:${address.port}`;
    const module = await Test.createTestingModule({ imports: [DistributionConfigModule, SkillModule] })
      .overrideProvider(CONFIG).useValue({ publicUrl: `${source}///` })
      .overrideProvider(SKILL_ASSETS).useValue(assets)
      .compile();
    const nest = module.createNestApplication(new ExpressAdapter(handler), { logger: false });
    try {
      await nest.init();
      const project = join(root, 'embedded-url-project');
      const home = join(root, 'embedded-url-home');
      const result = await execute('sh', ['-c', 'curl -fsSL "$SOURCE/skills/install.sh" | HOME="$TARGET_HOME" sh -s -- install codex --project "$PROJECT"'], {
        cwd: root, env: { ...process.env, SOURCE: source, TARGET_HOME: home, PROJECT: project, LLMWIKI_URL: '' },
      });
      expect(JSON.parse(result.stdout).state).toBe('current');
      expect(new SkillInstaller(assets, home).status('codex', { project }).state).toBe('current');
    } finally {
      await nest.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
