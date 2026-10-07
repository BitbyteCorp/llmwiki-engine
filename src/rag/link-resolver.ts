import { posix } from 'node:path';

/** Normalized link key, retaining the folder of a qualified target. */
export function normalizeLinkTarget(name: string): string {
  return name.split(/[#|]/, 1)[0]!.trim().replace(/\.md$/i, '').toLowerCase();
}

/** A reusable snapshot of authorized paths; duplicate names never choose a winner. */
export class NoteTargetResolver {
  private readonly paths = new Map<string, string[]>();
  private readonly basenames = new Map<string, string[]>();

  constructor(files: readonly string[]) {
    for (const file of files) {
      const path = file.replace(/\.md$/i, '').toLowerCase();
      const basename = posix.basename(file).replace(/\.md$/i, '').toLowerCase();
      const paths = this.paths.get(path);
      if (paths) paths.push(file);
      else this.paths.set(path, [file]);
      const basenames = this.basenames.get(basename);
      if (basenames) basenames.push(file);
      else this.basenames.set(basename, [file]);
    }
    for (const candidates of this.paths.values()) candidates.sort();
    for (const candidates of this.basenames.values()) candidates.sort();
  }

  resolve(name: string): { path: string | null; candidates: string[] } {
    const target = normalizeLinkTarget(name);
    const candidates = (target.includes('/') ? this.paths : this.basenames).get(target) ?? [];
    return { path: candidates.length === 1 ? candidates[0]! : null, candidates };
  }
}

/** One-shot resolution for callers without a reusable path snapshot. */
export function resolveNoteTarget(name: string, files: readonly string[]): { path: string | null; candidates: string[] } {
  return new NoteTargetResolver(files).resolve(name);
}
