export function planBatches(
  files: { path: string; chars: number }[],
  opts: { maxChars?: number; maxFiles?: number } = {},
): string[][] {
  const maxChars = opts.maxChars ?? 120_000;
  const maxFiles = opts.maxFiles ?? 40;
  const ordered = files.map((file) => {
    const segments = file.path.split('/');
    const last = segments.length - 1;
    // A page and its folder share a sorting key; the shorter page comes first.
    if (segments[last].endsWith('.md')) segments[last] = segments[last].slice(0, -3);
    return { file, segments };
  });
  ordered.sort((a, b) => {
    const length = Math.min(a.segments.length, b.segments.length);
    for (let index = 0; index < length; index++) {
      const left = a.segments[index];
      const right = b.segments[index];
      if (left !== right) return left < right ? -1 : 1;
    }
    if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
    return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
  });

  const batches: string[][] = [];
  let batch: string[] = [];
  let chars = 0;
  for (const { file } of ordered) {
    if (batch.length && (chars + file.chars > maxChars || batch.length >= maxFiles)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    if (file.chars > maxChars) {
      batches.push([file.path]);
      continue;
    }
    batch.push(file.path);
    chars += file.chars;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
