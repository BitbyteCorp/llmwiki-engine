import { posix } from 'node:path';

/** Normalized link key, retaining the folder of a qualified target. */
export function normalizeLinkTarget(name: string): string {
  return name.split(/[#|]/, 1)[0]!.trim().replace(/\.md$/i, '').toLowerCase();
}

/** A reusable snapshot of authorized paths; duplicate names never choose a winner. */
export class NoteTargetResolver {
  private readonly paths = new Map<string, string[]>();
  private readonly basenames = new Map<string, string[]>();
  private readonly aliases = new Map<string, string[]>();

  constructor(files: readonly string[], aliasesByPath?: ReadonlyMap<string, readonly string[]>) {
    for (const file of files) {
      const path = file.replace(/\.md$/i, '').toLowerCase();
      const basename = posix.basename(file).replace(/\.md$/i, '').toLowerCase();
      const paths = this.paths.get(path);
      if (paths) paths.push(file);
      else this.paths.set(path, [file]);
      const basenames = this.basenames.get(basename);
      if (basenames) basenames.push(file);
      else this.basenames.set(basename, [file]);
      const seen = new Set<string>();
      for (const alias of aliasesByPath?.get(file) ?? []) {
        const key = normalizeLinkTarget(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const aliases = this.aliases.get(key);
        if (aliases) aliases.push(file);
        else this.aliases.set(key, [file]);
      }
    }
    for (const candidates of this.paths.values()) candidates.sort();
    for (const candidates of this.basenames.values()) candidates.sort();
    for (const candidates of this.aliases.values()) candidates.sort();
  }

  /** All possible destinations, including fallback aliases, for backlink indexing. */
  candidatePaths(name: string): string[] {
    const target = normalizeLinkTarget(name);
    const exact = (target.includes('/') ? this.paths : this.basenames).get(target) ?? [];
    return [...new Set([...exact, ...(this.aliases.get(target) ?? [])])].sort();
  }

  resolve(name: string, readable?: (path: string) => boolean): { path: string | null; candidates: string[] } {
    const target = normalizeLinkTarget(name);
    const exact = (target.includes('/') ? this.paths : this.basenames).get(target) ?? [];
    const visibleExact = readable ? exact.filter(readable) : exact;
    const aliases = this.aliases.get(target) ?? [];
    const candidates = visibleExact.length ? visibleExact : readable ? aliases.filter(readable) : aliases;
    return { path: candidates.length === 1 ? candidates[0]! : null, candidates };
  }
}

/** One-shot resolution for callers without a reusable path snapshot. */
export function resolveNoteTarget(
  name: string, files: readonly string[], aliasesByPath?: ReadonlyMap<string, readonly string[]>,
): { path: string | null; candidates: string[] } {
  return new NoteTargetResolver(files, aliasesByPath).resolve(name);
}
