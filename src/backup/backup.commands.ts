import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { BackupService } from './backup.service.js';

export function registerBackupCommands(program: Command): void {
  const backup = program.command('backup').description('Create, verify, or restore an offline-compatible backup without starting Nest');
  backup.command('create').description('Snapshot SQLite, main history, and referenced uploads into a ZIP archive')
    .requiredOption('--out <path>', 'Destination archive (must not already exist)')
    .action(async (options: { out: string }) => {
      console.log(JSON.stringify(await new BackupService(loadConfig()).create(options.out), null, 2));
    });
  backup.command('verify <archive>').description('Verify checksums, SQLite integrity/schema compatibility, uploads, and Git bundle HEAD')
    .action(async (archive: string) => {
      console.log(JSON.stringify(await new BackupService(loadConfig()).verify(archive), null, 2));
    });
  backup.command('restore <archive>').description('Validate then replace DATA_DIR; a running server is always refused')
    .option('--force', 'Replace existing stopped-server data (never overrides a running server)', false)
    .action(async (archive: string, options: { force: boolean }) => {
      console.log(JSON.stringify(await new BackupService(loadConfig()).restore(archive, options), null, 2));
    });
}
