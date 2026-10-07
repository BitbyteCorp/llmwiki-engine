import { createReadStream } from 'node:fs';
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { Unzip, UnzipInflate, Zip, ZipPassThrough } from 'fflate';

export function archivePath(name: string): boolean {
  return name === 'manifest.json' || name === 'llmwiki.db' || name === 'knowledge.bundle'
    || /^uploads\/[a-zA-Z0-9_-]+$/.test(name);
}

export async function pack(directory: string, paths: string[], output: string): Promise<void> {
  const handle = await open(output, 'wx', 0o600);
  const destination = handle.createWriteStream();
  const complete = finished(destination);
  // Observe errors immediately, including failures before the first chunk.
  void complete.catch(() => undefined);
  const zip = new Zip((error, chunk, final) => {
    if (error) destination.destroy(error);
    else { destination.write(chunk); if (final) destination.end(); }
  });
  try {
    for (const path of paths) {
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      for await (const chunk of createReadStream(join(directory, path))) {
        if (destination.destroyed) await complete;
        entry.push(chunk as Buffer, false);
        if (destination.writableNeedDrain) await once(destination, 'drain');
      }
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    await complete;
  } catch (error) {
    zip.terminate();
    destination.destroy();
    await complete.catch(() => undefined);
    await rm(output, { force: true });
    throw error;
  }
}

/** Never extract archive filesystem metadata: create only whitelisted regular files. */
export async function unpack(archive: string, directory: string): Promise<string[]> {
  const paths: string[] = [];
  const handles = new Set<FileHandle>();
  let pending: Promise<void> = Promise.resolve();
  let failure: unknown;
  const unzip = new Unzip((entry) => {
    if (!archivePath(entry.name) || paths.includes(entry.name)) {
      failure = new Error(`Unsafe or duplicate backup member: ${entry.name}`);
      entry.terminate();
      return;
    }
    paths.push(entry.name);
    let handle: FileHandle;
    pending = pending.then(async () => {
      await mkdir(dirname(join(directory, entry.name)), { recursive: true });
      handle = await open(join(directory, entry.name), 'wx', 0o600);
      handles.add(handle);
    });
    entry.ondata = (error, chunk, final) => {
      if (error) { failure = error; return; }
      pending = pending.then(async () => {
        if (chunk.length) await handle.writeFile(chunk);
        if (final) { handles.delete(handle); await handle.close(); }
      });
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(archive)) {
      unzip.push(chunk as Buffer, false);
      await pending;
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(), true);
    await pending;
    if (failure) throw failure;
    if (handles.size) throw new Error('Truncated backup archive');
    return paths;
  } finally { await Promise.all([...handles].map((handle) => handle.close())); }
}
