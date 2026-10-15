import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../common/tokens.js';
import type { Config } from '../config.js';
import { skillClients } from './skill-installer.js';

export const SKILL_ASSETS = Symbol('SKILL_ASSETS');

/** Snapshot only the published files; request paths never become filesystem paths. */
@Injectable()
export class SkillDistributionService {
  readonly script: string;
  readonly version: Buffer;
  private readonly manifests = new Map<string, string>();
  private readonly contents = new Map<string, Buffer>();

  constructor(@Inject(CONFIG) config: Config, @Inject(SKILL_ASSETS) assets: string) {
    const read = (path: string): Buffer => {
      if (!lstatSync(path).isFile()) throw new Error(`Skill assets must be regular files: ${path}`);
      return readFileSync(path);
    };
    const remember = (content: Buffer): string => {
      const digest = createHash('sha256').update(content).digest('hex');
      this.contents.set(digest, content);
      return digest;
    };
    const engineUrl = config.publicUrl.replace(/\/+$/, '').replaceAll("'", "'\\''");
    this.script = read(join(assets, 'install.sh')).toString('utf8').replace("engine_url=''", () => `engine_url='${engineUrl}'`);
    this.version = read(join(assets, 'version.json'));
    const { version } = JSON.parse(this.version.toString('utf8')) as { version: unknown };
    if (typeof version !== 'string' || !version) throw new Error('Invalid skill bundle version.json.');
    const files = new Map<string, string>();
    const visit = (directory: string, prefix = ''): void => {
      if (!lstatSync(directory).isDirectory()) throw new Error(`Skill assets must be directories: ${directory}`);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path, name);
        else files.set(name, remember(read(path)));
      }
    };
    visit(join(assets, 'llmwiki'));
    if (!files.has('SKILL.md')) throw new Error('Canonical skill asset SKILL.md is missing');
    const manifestFiles = Object.fromEntries(files);
    for (const client of skillClients) {
      this.manifests.set(client, `${JSON.stringify({ schema: 1, client, version, files: manifestFiles }, null, 2)}\n`);
    }
  }

  manifest(client: string): string {
    const manifest = this.manifests.get(client);
    if (!manifest) throw new NotFoundException();
    return manifest;
  }

  file(digest: string): Buffer {
    const content = this.contents.get(digest);
    if (!content) throw new NotFoundException();
    return content;
  }
}
