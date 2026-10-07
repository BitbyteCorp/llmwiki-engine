import { createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { ExportService } from './export.service.js';

export function registerExportCommands(program: Command): void {
  program.command('export').description('Export committed knowledge from main without starting the server')
    .requiredOption('--out <path>', 'Destination file (must not already exist)')
    .option('--format <format>', 'zip or bundle', 'zip')
    .option('--prefix <path>', 'Committed file or directory prefix (ZIP only)', '')
    .action(async (options: { out: string; format: string; prefix: string }) => {
      if (options.format !== 'zip' && options.format !== 'bundle') throw new Error('Format must be zip or bundle');
      const download = await new ExportService(loadConfig()).prepare({ format: options.format, prefix: options.prefix });
      const output = resolve(options.out);
      let owned = false;
      try {
        const destination = createWriteStream(output, { flags: 'wx' });
        destination.once('open', () => { owned = true; });
        await pipeline(download.stream, destination);
        if (options.format === 'bundle') await writeFile(`${output}.manifest.json`, JSON.stringify(download.manifest, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ path: output, ...download.manifest }, null, 2));
      } catch (error) { if (owned) await rm(output, { force: true }); throw error; }
      finally { download.stream.destroy(); await download.dispose(); }
    });
}
