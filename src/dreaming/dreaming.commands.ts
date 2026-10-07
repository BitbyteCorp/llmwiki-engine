import type { INestApplicationContext } from '@nestjs/common';
import type { Command } from 'commander';
import { DreamingService } from './dreaming.service.js';

export function registerDreamCommands(
  program: Command,
  getApp: () => Promise<INestApplicationContext>,
): void {
  program.command('dream').description('지식 정리와 백업').command('run')
    .description('꿈꾸기를 즉시 한 번 실행한다')
    .action(async () => {
      const app = await getApp();
      const run = await app.get(DreamingService).runOnce();
      console.log(JSON.stringify(run, null, 2));
      if (run.status === 'failed') process.exitCode = 1;
    });
}
