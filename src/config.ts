import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

const optionalText = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATA_DIR: z.string().min(1).default('./data'),
  SESSION_SECRET: optionalText,
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().optional()),
  LUNA_MODEL: z.string().min(1).default('gpt-6-luna'),
  LUNA_REASONING_EFFORT: z.string().min(1).default('medium'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  KNOWLEDGE_REPO_URL: optionalText,
  GIT_SSH_KEY_PATH: optionalText,
  GIT_BOT_NAME: z.string().min(1).default('Luna'),
  GIT_BOT_EMAIL: z.email().default('luna@llmwiki.local'),
  DREAM_CRON: z.string().min(1).default('0 3 * * *'),
  TZ_DREAM: z.string().min(1).default('Asia/Seoul'),
  DEV_LOGIN_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.email().optional()),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (!env.SESSION_SECRET) ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET is required in production' });
    if (env.DEV_LOGIN_EMAIL) ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_EMAIL'], message: 'DEV_LOGIN_EMAIL must not be set in production' });
  }
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number; publicUrl: string; dataDir: string; sessionSecret: string;
  openaiApiKey?: string; openaiBaseUrl?: string;
  lunaModel: string; lunaReasoningEffort: string;
  embeddingModel: string; embeddingDimensions: number;
  googleClientId?: string; googleClientSecret?: string;
  knowledgeRepoUrl?: string; gitSshKeyPath?: string;
  gitBotName: string; gitBotEmail: string;
  dreamCron: string; tzDream: string; devLoginEmail?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV, port: parsed.PORT, publicUrl: parsed.PUBLIC_URL,
    dataDir: resolve(parsed.DATA_DIR), sessionSecret: parsed.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    openaiApiKey: parsed.OPENAI_API_KEY, openaiBaseUrl: parsed.OPENAI_BASE_URL,
    lunaModel: parsed.LUNA_MODEL, lunaReasoningEffort: parsed.LUNA_REASONING_EFFORT,
    embeddingModel: parsed.EMBEDDING_MODEL, embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    googleClientId: parsed.GOOGLE_CLIENT_ID, googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    knowledgeRepoUrl: parsed.KNOWLEDGE_REPO_URL, gitSshKeyPath: parsed.GIT_SSH_KEY_PATH,
    gitBotName: parsed.GIT_BOT_NAME, gitBotEmail: parsed.GIT_BOT_EMAIL,
    dreamCron: parsed.DREAM_CRON, tzDream: parsed.TZ_DREAM, devLoginEmail: parsed.DEV_LOGIN_EMAIL,
  };
}
