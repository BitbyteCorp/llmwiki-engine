#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Command, CommanderError } from 'commander';
import { AppModule } from './app.module.js';
import { registerAuthCommands } from './auth/auth.commands.js';
import { registerRagCommands } from './rag/rag.commands.js';
import { registerDreamCommands } from './dreaming/dreaming.commands.js';
import { registerLintCommands } from './dreaming/lint.commands.js';
import { registerExportCommands } from './export/export.commands.js';
import { registerBackupCommands } from './backup/backup.commands.js';
import { registerSkillCommands } from './skill/skill.commands.js';
import { logger } from './log.js';

const program = new Command();
program.name('llmwiki').description('Manage the LLM Wiki engine').version('0.1.0');
let pendingApp: Promise<INestApplicationContext> | undefined;
const getApp = (): Promise<INestApplicationContext> => pendingApp ??= NestFactory.createApplicationContext(AppModule, { logger: false });

try {
  registerAuthCommands(program, getApp);
  registerRagCommands(program, getApp);
  registerDreamCommands(program, getApp);
  registerLintCommands(program);
  registerExportCommands(program);
  registerBackupCommands(program);
  registerSkillCommands(program);
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    logger.error({ code: error.code }, 'Invalid command arguments; passwords must be supplied through stdin, never arguments');
  } else {
    logger.error({ err: error }, 'llmwiki command failed');
  }
  process.exitCode = 1;
} finally {
  if (pendingApp) {
    const app = await pendingApp.catch(() => undefined);
    if (app) {
      try {
        await app.close();
      } catch (error) {
        logger.error({ err: error }, 'llmwiki command cleanup failed');
        process.exitCode = 1;
      }
    }
  }
}
