import pino from 'pino';

export const logger = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie', 'sessionSecret', 'openaiApiKey', 'googleClientSecret',
    'accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token', 'id_token',
    '*.accessToken', '*.refreshToken', '*.idToken', '*.access_token', '*.refresh_token', '*.id_token'],
});
export type { Logger } from 'pino';
