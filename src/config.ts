import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

const optionalText = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATA_DIR: z.string().min(1).default('./data'),
  JOBS_AUTOSTART: z.enum(['true', 'false']).default('true'),
  SESSION_SECRET: optionalText,
  OPENAI_API_KEY: optionalText,
  OPENAI_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().optional()),
  CODEX_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().default('https://chatgpt.com/backend-api/codex')),
  OPENAI_MAX_RETRIES: z.coerce.number().int().nonnegative().default(8),
  LLM_PROVIDER: z.enum(['openai', 'openrouter', 'openai-codex']).default('openai'),
  LLM_MODELS: z.string()
    .transform(value => value.split(',').map(model => model.trim()).filter(Boolean))
    .pipe(z.array(z.string()).nonempty()).optional(),
  LLM_REASONING_EFFORT: z.string().min(1).default('medium'),
  LLM_BACKGROUND_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  LLM_COMPACT_THRESHOLD: z.coerce.number().int().positive().default(50000),
  EMBEDDING_MODEL: optionalText,
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  SEARCH_RERANK: z.enum(['off', 'llm']).default('off'),
  SEARCH_EXPAND: z.enum(['off', 'llm']).default('off'),
  INDEX_POLL_SECONDS: z.coerce.number().int().min(1).max(86400).default(60),
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  KNOWLEDGE_REPO_URL: optionalText,
  GIT_SSH_KEY_PATH: optionalText,
  GIT_BOT_NAME: z.string().min(1).default('도니'),
  GIT_BOT_EMAIL: z.email().default('dony@llmwiki.local'),
  DREAM_CRON: z.string().min(1).default('0 3 * * *'),
  TZ_DREAM: z.string().min(1).default('Asia/Seoul'),
  SLACK_WEBHOOK_URL: z.preprocess((value) => value === '' ? undefined : value, z.url().optional()),
  DEV_LOGIN_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.email().optional()),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTH: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_USER: z.coerce.number().int().positive().default(60),
  AUTH_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  METRICS_TOKEN: optionalText,
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (!env.SESSION_SECRET) ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET is required in production' });
    if (env.DEV_LOGIN_EMAIL) ctx.addIssue({ code: 'custom', path: ['DEV_LOGIN_EMAIL'], message: 'DEV_LOGIN_EMAIL must not be set in production' });
  }
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number; publicUrl: string; dataDir: string; sessionSecret: string;
  jobsAutostart?: boolean;
  openaiApiKey?: string; openaiBaseUrl?: string; openaiMaxRetries?: number;
  codexBaseUrl?: string;
  llmProvider: 'openai' | 'openrouter' | 'openai-codex';
  llmModels: string[]; llmModel: string; llmReasoningEffort: string;
  llmBackgroundReasoningEffort: string;
  llmCompactThreshold: number;
  embeddingModel: string; embeddingDimensions: number;
  searchRerank?: 'off' | 'llm'; searchExpand?: 'off' | 'llm'; indexPollSeconds?: number;
  googleClientId?: string; googleClientSecret?: string;
  knowledgeRepoUrl?: string; gitSshKeyPath?: string;
  gitBotName: string; gitBotEmail: string;
  dreamCron: string; tzDream: string; devLoginEmail?: string;
  slackWebhookUrl?: string;
  trustProxy?: boolean;
  rateLimitWindowMs?: number; rateLimitAuth?: number; rateLimitUser?: number;
  authCleanupIntervalMs?: number;
  metricsToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const llmModels = parsed.LLM_MODELS ?? [parsed.LLM_PROVIDER === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna'];
  return {
    nodeEnv: parsed.NODE_ENV, port: parsed.PORT, publicUrl: parsed.PUBLIC_URL,
    dataDir: resolve(parsed.DATA_DIR), sessionSecret: parsed.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    jobsAutostart: parsed.JOBS_AUTOSTART === 'true',
    openaiApiKey: parsed.OPENAI_API_KEY,
    openaiBaseUrl: parsed.OPENAI_BASE_URL ?? (parsed.LLM_PROVIDER === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined),
    codexBaseUrl: parsed.CODEX_BASE_URL,
    openaiMaxRetries: parsed.OPENAI_MAX_RETRIES,
    llmProvider: parsed.LLM_PROVIDER,
    llmModels, llmModel: llmModels[0], llmReasoningEffort: parsed.LLM_REASONING_EFFORT,
    llmBackgroundReasoningEffort: parsed.LLM_BACKGROUND_REASONING_EFFORT,
    llmCompactThreshold: parsed.LLM_COMPACT_THRESHOLD,
    embeddingModel: parsed.EMBEDDING_MODEL ?? (parsed.LLM_PROVIDER === 'openrouter' ? 'openai/text-embedding-3-small' : 'text-embedding-3-small'),
    embeddingDimensions: parsed.EMBEDDING_DIMENSIONS,
    searchRerank: parsed.SEARCH_RERANK, searchExpand: parsed.SEARCH_EXPAND, indexPollSeconds: parsed.INDEX_POLL_SECONDS,
    googleClientId: parsed.GOOGLE_CLIENT_ID, googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    knowledgeRepoUrl: parsed.KNOWLEDGE_REPO_URL, gitSshKeyPath: parsed.GIT_SSH_KEY_PATH,
    gitBotName: parsed.GIT_BOT_NAME, gitBotEmail: parsed.GIT_BOT_EMAIL,
    dreamCron: parsed.DREAM_CRON, tzDream: parsed.TZ_DREAM, devLoginEmail: parsed.DEV_LOGIN_EMAIL,
    slackWebhookUrl: parsed.SLACK_WEBHOOK_URL,
    trustProxy: parsed.TRUST_PROXY === 'true',
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitAuth: parsed.RATE_LIMIT_AUTH,
    rateLimitUser: parsed.RATE_LIMIT_USER,
    authCleanupIntervalMs: parsed.AUTH_CLEANUP_INTERVAL_MS,
    metricsToken: parsed.METRICS_TOKEN,
  };
}
