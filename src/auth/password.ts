import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { UserServiceError } from './users.types.js';

const SCRYPT_OPTIONS = { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_KEY = Buffer.alloc(64);

function checkLength(password: string): void {
  let length = 0;
  for (const _ of password) {
    if (++length > 128) break;
  }
  if (length < 8 || length > 128) {
    throw new UserServiceError(400, 'weak_password', 'Password must contain 8 to 128 Unicode code points before and after normalization');
  }
}

export function normalizePassword(password: string): string {
  checkLength(password);
  const normalized = password.normalize('NFKC');
  checkLength(normalized);
  return normalized;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
  return promise;
}

export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(normalized, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  let normalized: string;
  let validPassword = true;
  try {
    normalized = normalizePassword(password);
  } catch (error) {
    if (!(error instanceof UserServiceError)) throw error;
    // Invalid input still consumes the same scrypt work as unknown accounts.
    normalized = 'invalid-password';
    validPassword = false;
  }
  const match = hash?.match(HASH_PATTERN);
  const salt = match ? Buffer.from(match[1]!, 'hex') : DUMMY_SALT;
  const expected = match ? Buffer.from(match[2]!, 'hex') : DUMMY_KEY;
  const actual = await deriveKey(normalized, salt);
  const equal = timingSafeEqual(actual, expected);
  return validPassword && Boolean(match) && equal;
}
