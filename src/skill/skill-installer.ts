import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const skillClients = ['claude-code', 'codex', 'hermes', 'cline', 'kiro', 'qwen-code'] as const;
export type SkillClient = typeof skillClients[number];
export const installMarker = '.llmwiki-install.json';
const roots: Record<SkillClient, string> = {
  'claude-code': '.claude', codex: '.agents', hermes: '.hermes',
  cline: '.cline', kiro: '.kiro', 'qwen-code': '.qwen',
};
const markerSchema = z.object({
  schema: z.literal(1),
  client: z.enum(skillClients),
  version: z.string().min(1),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
type Marker = z.infer<typeof markerSchema>;
export type SkillStatus = {
  client: SkillClient;
  directory: string;
  state: 'not-installed' | 'unmanaged' | 'modified' | 'outdated' | 'current';
  installedVersion: string | null;
  availableVersion: string;
  modifiedFiles: string[];
  unmanagedFiles: string[];
};
export type SkillInstallOptions = { project?: string; force?: boolean };

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function entryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function safePath(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (entryExists(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symlink installation path: ${current}`);
    }
    if (dirname(current) === current) return;
  }
}

function safeFileName(path: string): boolean {
  return path !== installMarker && path !== '' && !isAbsolute(path)
    && !path.split(/[\\/]/).some((part) => part === '..' || part === '.' || part === '');
}

function loadFiles(directory: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, content] of loadFiles(path, name)) files.set(child, content);
    } else if (entry.isFile()) {
      files.set(name, readFileSync(path));
    } else {
      throw new Error(`Skill assets must be regular files: ${path}`);
    }
  }
  return files;
}

/** Assets stay beside src/ and dist/; resolution never depends on the caller's cwd. */
export class SkillInstaller {
  constructor(
    private readonly assetsDirectory = fileURLToPath(new URL('../../skills/', import.meta.url)),
    private readonly homeDirectory = homedir(),
  ) {}

  private bundle(): { version: string; files: Map<string, Buffer> } {
    const { version } = z.object({ version: z.string().min(1) }).parse(
      JSON.parse(readFileSync(join(this.assetsDirectory, 'version.json'), 'utf8')),
    );
    const files = loadFiles(join(this.assetsDirectory, 'llmwiki'));
    if (!files.has('SKILL.md')) throw new Error('Canonical skill asset SKILL.md is missing');
    return { version, files };
  }

  private marker(directory: string, client: SkillClient): Marker | null {
    const path = join(directory, installMarker);
    if (!entryExists(path) || !lstatSync(path).isFile()) return null;
    try {
      const marker = markerSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (marker.client !== client || !Object.keys(marker.files).every(safeFileName)) return null;
      return marker;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
      throw error;
    }
  }

  status(client: SkillClient, options: Pick<SkillInstallOptions, 'project'> = {}): SkillStatus {
    const bundle = this.bundle();
    return this.inspect(client, resolve(options.project ?? this.homeDirectory, roots[client], 'skills', 'llmwiki'), bundle);
  }

  private inspect(client: SkillClient, directory: string, bundle: { version: string; files: Map<string, Buffer> }): SkillStatus {
    safePath(directory);
    const marker = this.marker(directory, client);
    const modifiedFiles: string[] = [];
    const unmanagedFiles: string[] = [];
    for (const [name, expected] of Object.entries(marker?.files ?? {})) {
      const path = join(directory, name);
      safePath(path);
      if (!entryExists(path) || !lstatSync(path).isFile() || hash(readFileSync(path)) !== expected) modifiedFiles.push(name);
    }
    for (const name of bundle.files.keys()) {
      const path = join(directory, name);
      safePath(path);
      if (!marker?.files[name] && entryExists(path)) unmanagedFiles.push(name);
    }
    const changedBundle = marker && (marker.version !== bundle.version
      || Object.keys(marker.files).length !== bundle.files.size
      || [...bundle.files].some(([name, content]) => marker.files[name] !== hash(content)));
    const state = !entryExists(directory) ? 'not-installed'
      : !marker ? 'unmanaged'
      : modifiedFiles.length ? 'modified'
      : unmanagedFiles.length ? 'unmanaged'
      : changedBundle ? 'outdated' : 'current';
    return { client, directory, state, installedVersion: marker?.version ?? null,
      availableVersion: bundle.version, modifiedFiles, unmanagedFiles };
  }

  install(client: SkillClient, action: 'install' | 'update', options: SkillInstallOptions = {}): SkillStatus & { changed: boolean } {
    const bundle = this.bundle();
    const directory = resolve(options.project ?? this.homeDirectory, roots[client], 'skills', 'llmwiki');
    const status = this.inspect(client, directory, bundle);
    if (action === 'update' && status.state === 'not-installed') {
      throw new Error(`Skill is not installed at ${directory}; run skill install ${client} first`);
    }
    const marker = this.marker(directory, client);
    const markerPath = join(directory, installMarker);
    const conflicts = [...status.modifiedFiles, ...status.unmanagedFiles];
    if (!marker && entryExists(markerPath)) conflicts.push(installMarker);
    if (conflicts.length && !options.force) {
      throw new Error(`Refusing to overwrite locally modified or unmanaged files: ${conflicts.join(', ')}. Review them and use --force to replace skill files only.`);
    }
    if (status.state === 'current') return { ...status, changed: false };
    // Check every destination before any write; force never follows links or replaces directories.
    for (const name of new Set([...bundle.files.keys(), ...Object.keys(marker?.files ?? {}), installMarker])) {
      const path = join(directory, name);
      safePath(path);
      if (entryExists(path) && !lstatSync(path).isFile()) throw new Error(`Refusing non-file skill destination: ${path}`);
      for (let current = dirname(path); ; current = dirname(current)) {
        if (entryExists(current) && !lstatSync(current).isDirectory()) throw new Error(`Refusing non-directory skill parent: ${current}`);
        if (dirname(current) === current) break;
      }
    }
    mkdirSync(directory, { recursive: true });
    for (const [name, content] of bundle.files) {
      const path = join(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    for (const name of Object.keys(marker?.files ?? {})) {
      const path = join(directory, name);
      if (!bundle.files.has(name) && existsSync(path)) unlinkSync(path);
    }
    const nextMarker: Marker = { schema: 1, client, version: bundle.version,
      files: Object.fromEntries([...bundle.files].map(([name, content]) => [name, hash(content)])) };
    writeFileSync(markerPath, `${JSON.stringify(nextMarker, null, 2)}\n`);
    return { ...this.inspect(client, directory, bundle), changed: true };
  }
}
