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

  async content(path: string) {
    // Pin one main snapshot so content and its revision cannot diverge during a merge.
    const updatedSha = await this.repo.headSha();
    const content = await this.repo.readFile(path, updatedSha);
    if (content === null) notFound('Note not found');
    const parsed = matter(content);
    return { path, content, frontmatter: parsed.data, body: parsed.content, updatedSha };
  }

  async resolve(name: string) {
    const target = name.replace(/\.md$/i, '').toLowerCase();
    const files = await this.repo.listFiles(undefined, 'main');
    const path = files.sort().find((file) => posix.basename(file).replace(/\.md$/i, '').toLowerCase() === target);
    if (!path) notFound('Note not found');
    return { path };
  }
}
