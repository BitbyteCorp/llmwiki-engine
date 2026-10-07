import { createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Command } from 'commander';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { openDb, runMigrations } from '../db/index.js';
import { loadConfig } from '../config.js';
import { ExportService, type ExportDownload } from './export.service.js';

export function registerExportCommands(program: Command): void {
  program.command('export').description('Export committed knowledge from main without starting the server')
    .requiredOption('--out <path>', 'Destination file (must not already exist)')
    .option('--format <format>', 'zip or bundle', 'zip')
    .option('--prefix <path>', 'Committed file or directory prefix (ZIP only)', '')
    .action(async (options: { out: string; format: string; prefix: string }) => {
      if (options.format !== 'zip' && options.format !== 'bundle') throw new Error('Format must be zip or bundle');
      const config = loadConfig();
      const db = openDb(join(config.dataDir, 'llmwiki.db'));
      let download: ExportDownload | undefined;
      const output = resolve(options.out);
      let owned = false;
      try {
        runMigrations(db);
        const users = new UsersService(new UsersRepository(db));
        const acl = new AclService(db, users, new AuditService(db));
        // Local CLI is an explicit unrestricted system export, not a remote authenticated surface.
        download = await new ExportService(config, acl, users).prepare({ format: options.format, prefix: options.prefix });
        const destination = createWriteStream(output, { flags: 'wx' });
        destination.once('open', () => { owned = true; });
        await pipeline(download.stream, destination);
        if (options.format === 'bundle') await writeFile(`${output}.manifest.json`, JSON.stringify(download.manifest, null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ path: output, ...download.manifest }, null, 2));
      } catch (error) { if (owned) await rm(output, { force: true }); throw error; }
      finally {
        if (download) { download.stream.destroy(); await download.dispose(); }
        db.close();
      }
    });
}
