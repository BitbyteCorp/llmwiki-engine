import { posix } from 'node:path';
import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { notFound } from './api-error.js';

@Injectable()
export class NotesService {
  constructor(private readonly repo: KnowledgeRepo) {}

  tree(): Promise<string[]> {
    return this.repo.listFiles(undefined, 'main');
  }

  async content(path: string, ref?: string) {
    // Pin one snapshot so content and its revision cannot diverge during a merge.
    const updatedSha = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
    const content = await this.repo.readFile(path, updatedSha);
    if (content === null) notFound('Note not found');
    const parsed = matter(content);
    return { path, content, frontmatter: parsed.data, body: parsed.content, updatedSha, ref: updatedSha };
  }

  async resolve(name: string) {
    const target = name.split('#', 1)[0]!.replace(/\.md$/i, '').toLowerCase();
    const files = await this.repo.listFiles(undefined, 'main');
    const candidates = files.filter((file) => {
      const candidate = target.includes('/') ? file : posix.basename(file);
      return candidate.replace(/\.md$/i, '').toLowerCase() === target;
    }).sort();
    if (!candidates.length) notFound('Note not found');
    return { path: candidates.length === 1 ? candidates[0]! : null, candidates };
  }

  async blame(path: string, ref?: string) {
    const resolved = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
    if (await this.repo.readFile(path, resolved) === null) notFound('Note not found');
    return this.repo.blame(path, resolved);
  }
}
