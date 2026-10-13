import { scrypt as nodeScrypt } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

import { hashPassword, normalizePassword, verifyPassword } from './password.js';

const scrypt = vi.mocked(nodeScrypt);

describe('password policy', () => {
  it('normalizes NFKC without trimming and accepts spaces and Unicode', () => {
    expect(normalizePassword('ｐａｓｓｗｏｒｄ')).toBe('password');
    expect(normalizePassword('  password  ')).toBe('  password  ');
    expect(normalizePassword('        ')).toBe('        ');
    expect(normalizePassword('😀'.repeat(8))).toBe('😀'.repeat(8));
    expect(normalizePassword('😀'.repeat(128))).toBe('😀'.repeat(128));
  });

  it.each(['', 'a'.repeat(7), 'a'.repeat(129), '😀'.repeat(7), '😀'.repeat(129), 'ﬀ'.repeat(65), 'e\u0301'.repeat(4)])(
    'rejects code point lengths outside the policy before or after normalization %#',
    (password) => {
      expect(() => normalizePassword(password)).toThrow(expect.objectContaining({ status: 400, code: 'weak_password' }));
    },
  );

  it('accepts both boundaries after normalization', () => {
    expect(normalizePassword('a'.repeat(8))).toHaveLength(8);
    expect(normalizePassword('a'.repeat(128))).toHaveLength(128);
    expect(normalizePassword('ﬀ'.repeat(64))).toBe('f'.repeat(128));
  });
});

describe('asynchronous scrypt password hashes', () => {
  it('uses fresh salts, the fixed work parameters, and the required encoding', async () => {
    const first = await hashPassword('correct password');
    const second = await hashPassword('correct password');
    expect(first).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(second).not.toBe(first);
    expect(scrypt).toHaveBeenLastCalledWith('correct password', expect.any(Buffer), 64,
      { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 }, expect.any(Function));
    await expect(verifyPassword('correct password', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', first)).resolves.toBe(false);
  });

  it('verifies canonically equivalent passwords but does not trim whitespace', async () => {
    const hash = await hashPassword('ｐａｓｓｗｏｒｄ');
    await expect(verifyPassword('password', hash)).resolves.toBe(true);
    await expect(verifyPassword(' password ', hash)).resolves.toBe(false);
  });

  it.each([null, '', 'not-a-hash', 'scrypt$00$00', `scrypt$${'AB'.repeat(16)}$${'ab'.repeat(64)}`])(
    'performs dummy scrypt for unavailable or malformed hashes %#',
    async (hash) => {
      const before = scrypt.mock.calls.length;
      await expect(verifyPassword('correct password', hash)).resolves.toBe(false);
      expect(scrypt.mock.calls.length).toBe(before + 1);
      expect(scrypt.mock.lastCall?.[1]).toEqual(Buffer.alloc(16));
    },
  );

  it('returns false rather than policy errors for invalid login passwords, still doing scrypt', async () => {
    const hash = await hashPassword('correct password');
    for (const password of ['short', 'a'.repeat(129), 'ﬀ'.repeat(65)]) {
      const before = scrypt.mock.calls.length;
      await expect(verifyPassword(password, hash)).resolves.toBe(false);
      expect(scrypt.mock.calls.length).toBe(before + 1);
    }
  });

  it('does not derive a hash for a weak new password', async () => {
    const before = scrypt.mock.calls.length;
    await expect(hashPassword('short')).rejects.toMatchObject({ status: 400, code: 'weak_password' });
    expect(scrypt.mock.calls.length).toBe(before);
  });

  it('yields the event loop before hashing completes', async () => {
    let finished = false;
    const pending = hashPassword('correct password').then(() => { finished = true; });
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
    expect(finished).toBe(false);
    await pending;
  });
});
