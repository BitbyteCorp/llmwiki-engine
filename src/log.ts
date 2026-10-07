import pino from 'pino';

export const logger = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie', 'sessionSecret', 'openaiApiKey', 'googleClientSecret'],
});
export type { Logger } from 'pino';
