import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import type { User } from '../auth/users.types.js';
import { AclService } from '../acl/acl.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { resolveNoteTarget } from '../rag/link-resolver.js';
import { ApiError, notFound } from './api-error.js';
import { visibleBlame } from './acl-history.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function imageContentType(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const prefix = bytes.subarray(0, 12).toString('latin1');
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif';
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp';
  throw new ApiError(415, 'unsupported_media_type', 'Asset is not a supported raster image');
}

@Injectable()
export class NotesService {
  constructor(private readonly repo: KnowledgeRepo, private readonly acl: AclService) {}

  async tree(user?: User): Promise<string[]> {
    // An omitted user is reserved for explicit internal SYSTEM callers.
    const files = await this.repo.listFiles(undefined, 'main');
    return user ? this.acl.filterPaths(user, files) : files;
  }

  async content(path: string, ref?: string, user?: User) {
    if (user) this.acl.assertRead(user, path);
    // Pin one snapshot so content and its revision cannot diverge during a merge.
    const updatedSha = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
    const content = await this.repo.readFile(path, updatedSha);
    if (user) this.acl.assertRead(user, path);
    if (content === null) notFound('Note not found');
    const parsed = matter(content);
    return { path, content, frontmatter: parsed.data, body: parsed.content, updatedSha, ref: updatedSha };
  }

  async raw(path: string, ref?: string, user?: User) {
    if (user) this.acl.assertRead(user, path);
    const resolved = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
    const bytes = await this.repo.readFileBytes(path, resolved);
    if (user) this.acl.assertRead(user, path);
    if (bytes === null) notFound('Asset not found');
    return { bytes, contentType: imageContentType(bytes) };
  }

  async resolve(name: string, user?: User) {
    const sha = await this.repo.headSha();
    const files = await this.repo.listFiles(undefined, sha);
    let visible = user ? this.acl.filterPaths(user, files) : files;
    let result = resolveNoteTarget(name, visible);
    if (result.candidates.length) return result;
    const aliases = new Map<string, string[]>();
    for (const path of visible) {
      const content = await this.repo.readFile(path, sha);
      if (content === null) continue;
      const value: unknown = matter(content).data.aliases;
      if (Array.isArray(value) && value.every((alias: unknown) => typeof alias === 'string')) {
        aliases.set(path, (value as string[]).map((alias) => alias.trim()).filter(Boolean));
      }
    }
    // ACL rules can change while the repository reads are pending.
    visible = user ? this.acl.filterPaths(user, visible) : visible;
    result = resolveNoteTarget(name, visible, aliases);
    if (!result.candidates.length) notFound('Note not found');
    return result;
  }

  async blame(path: string, ref?: string, user?: User) {
    if (user) this.acl.assertRead(user, path);
    const resolved = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
    if (await this.repo.readFile(path, resolved) === null) notFound('Note not found');
    return user ? visibleBlame(this.repo, this.acl, user, path, resolved) : this.repo.blame(path, resolved);
  }
}
