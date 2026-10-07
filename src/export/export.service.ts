import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { AclService } from '../acl/acl.service.js';
import { ApiError } from '../api/api-error.js';
import type { User } from '../auth/users.types.js';
import { UsersService } from '../auth/users.service.js';
import { CONFIG } from '../common/tokens.js';
import type { Config } from '../config.js';
import { bundleMain, git } from './git.js';

export interface ExportManifest { version: 1; headSha: string; createdAt: string; format: 'zip' | 'bundle'; prefix: string }
export interface ExportDownload { filename: string; contentType: string; manifest: ExportManifest; stream: Readable; assertAuthorized(): void; dispose(): Promise<void> }

function safePrefix(input: string): string {
  if (isAbsolute(input) || win32.isAbsolute(input) || /[\\\0]/.test(input)
    || input.split('/').some((part) => part === '..' || part.toLowerCase() === '.git')) {
    throw new ApiError(400, 'invalid_prefix', 'Prefix must be a repository-relative path');
  }
  return input.split('/').filter((part) => part && part !== '.').join('/');
}

@Injectable()
export class ExportService {
  constructor(@Inject(CONFIG) private readonly config: Config, private readonly acl: AclService, private readonly users: UsersService) {}

  /** Omitting user is reserved for the local, unrestricted system CLI. HTTP always supplies identity. */
  async prepare(options: { prefix?: string; format?: 'zip' | 'bundle' } = {}, user?: User): Promise<ExportDownload> {
    const format = options.format ?? 'zip';
    const prefix = safePrefix(options.prefix ?? '');
    const policyKey = user ? this.acl.policyKey(user) : null;
    const assertAuthorized = () => {
      if (!user) return; // Explicit local system CLI only.
      const current = this.users.getById(user.id);
      if (!current || current.email !== user.email || current.createdAt !== user.createdAt ||
        this.acl.policyKey(current) !== policyKey ||
        (format === 'bundle' && current.role !== 'admin' && this.acl.list().length)) {
        throw new ApiError(403, 'forbidden', 'Permissions changed during the export');
      }
    };
    assertAuthorized();
    if (format === 'bundle' && prefix) throw new ApiError(400, 'invalid_prefix', 'Git bundles preserve full history and cannot be prefix-filtered');
    const repo = join(this.config.dataDir, 'knowledge');
    const directory = await mkdtemp(join(tmpdir(), 'llmwiki-export-'));
    const dispose = () => rm(directory, { recursive: true, force: true });
    try {
      assertAuthorized();
      let headSha = (await git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}'])).trim();
      if (format === 'bundle') headSha = await bundleMain(repo, join(directory, 'knowledge.bundle'));
      const paths = (await git(repo, ['ls-tree', '-r', '-z', '--name-only', headSha, '--', ...(prefix ? [prefix] : [])]))
        .split('\0').filter(Boolean);
      assertAuthorized();
      const selected = user ? this.acl.filterPaths(user, paths) : paths;
      if (format === 'zip' && !selected.length) throw new ApiError(404, 'not_found', 'No committed files match the prefix');
      const manifest: ExportManifest = { version: 1, headSha, createdAt: new Date().toISOString(), format, prefix };
      let stream: Readable;
      if (format === 'bundle') {
        assertAuthorized();
        stream = createReadStream(join(directory, 'knowledge.bundle'));
      } else {
        if (selected.includes('manifest.json')) throw new ApiError(409, 'manifest_conflict', 'The repository already tracks reserved export path manifest.json');
        const manifestPath = join(directory, 'manifest.json');
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        assertAuthorized();
        const child = spawn('git', ['archive', '--format=zip', `--add-file=${manifestPath}`, headSha, '--', ...selected], {
          cwd: repo, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = new PassThrough();
        child.stdout.pipe(output, { end: false });
        stream = output;
        let errorOutput = '';
        child.stderr.on('data', (chunk: Buffer) => { if (errorOutput.length < 8192) errorOutput += chunk.toString(); });
        child.on('error', (error) => stream.destroy(error));
        child.stdout.on('error', (error) => output.destroy(error));
        child.on('close', (code) => {
          if (code === 0) output.end();
          else output.destroy(new Error(errorOutput || `git archive exited ${code}`));
        });
        output.on('close', () => { if (!output.readableEnded && child.exitCode === null) child.kill(); });
      }
      return { filename: `llmwiki-${headSha.slice(0, 12)}.${format}`, contentType: format === 'zip' ? 'application/zip' : 'application/octet-stream', manifest, stream, assertAuthorized, dispose };
    } catch (error) { await dispose(); throw error; }
  }
}
