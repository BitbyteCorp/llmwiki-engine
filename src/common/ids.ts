import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Engine identifiers are 128-bit UUID v4 values with two encodings:
 * - API/application form: fixed-width 22-character base62 (`0-9A-Za-z`), used everywhere outside SQLite.
 * - Storage form: 22-character unpadded base64url, used only in SQLite id columns.
 * Canonical 36-character UUID strings are legacy input (old bookmarks, MCP clients, Git trailers) and are
 * accepted on input only; nothing emits them.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const API_LENGTH = 22;
const MAX = (1n << 128n) - 1n;
const API_PATTERN = /^[0-9A-Za-z]{22}$/;
// 16 bytes in unpadded base64url: the last character carries only two bits.
const STORAGE_PATTERN = /^[A-Za-z0-9_-]{21}[AQgw]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = new Map([...ALPHABET].map((char, index) => [char, BigInt(index)]));

function encodeBase62(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  for (let index = 0; index < API_LENGTH; index++) {
    out = ALPHABET[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
}

function decodeBase62(id: string): Buffer | null {
  if (!API_PATTERN.test(id)) return null;
  let value = 0n;
  for (const char of id) value = value * 62n + DIGITS.get(char)!;
  return value > MAX ? null : Buffer.from(value.toString(16).padStart(32, '0'), 'hex');
}

function uuidBytes(uuid: string): Buffer | null {
  return UUID_PATTERN.test(uuid) ? Buffer.from(uuid.replaceAll('-', ''), 'hex') : null;
}

/** A new identifier in API form. */
export function newId(): string {
  return encodeBase62(uuidBytes(randomUUID())!);
}

/** Normalizes API input (base62 or legacy canonical UUID) to API form; `null` when it is not an identifier. */
export function parseApiId(value: string): string | null {
  if (API_PATTERN.test(value)) return decodeBase62(value) ? value : null;
  const legacy = uuidBytes(value);
  return legacy ? encodeBase62(legacy) : null;
}

/** API-form (or legacy UUID) identifier to its SQLite storage form; `null` when it is not an identifier. */
export function toStorageId(value: string): string | null {
  const bytes = decodeBase62(value) ?? uuidBytes(value);
  return bytes ? bytes.toString('base64url') : null;
}

/** SQLite storage form to API form. Throws on corrupt storage values instead of leaking them. */
export function fromStorageId(stored: string): string {
  if (!STORAGE_PATTERN.test(stored)) throw new Error(`Invalid stored id: ${stored}`);
  return encodeBase62(Buffer.from(stored, 'base64url'));
}

/** Legacy canonical UUID to storage form; migration helper that leaves non-UUID values untouched. */
export function legacyUuidToStorage(value: string): string {
  const bytes = uuidBytes(value);
  return bytes ? bytes.toString('base64url') : value;
}

/** Legacy canonical UUID to API form; leaves non-UUID values (e.g. `initialize` trailers) untouched. */
export function legacyUuidToApi(value: string): string {
  const bytes = uuidBytes(value);
  return bytes ? encodeBase62(bytes) : value;
}

/** API-form id to the canonical UUID it was migrated from; only for finding pre-migration artifacts (e.g. Git refs). */
export function apiIdToLegacyUuid(id: string): string | null {
  const hex = decodeBase62(id)?.toString('hex');
  return hex ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
}

/** Replaces every canonical UUID inside a text/JSON document with the given encoding. */
export function replaceLegacyUuids(text: string, encode: (uuid: string) => string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, encode);
}

/** Zod schema for identifier input; outputs the normalized API form. */
export const idSchema = z.string().transform((value, ctx) => {
  const id = parseApiId(value);
  if (!id) {
    ctx.addIssue({ code: 'custom', message: 'Invalid id' });
    return z.NEVER;
  }
  return id;
});
