import { describe, expect, it } from 'vitest';
import {
  apiIdToLegacyUuid,
  fromStorageId,
  idSchema,
  legacyUuidToApi,
  legacyUuidToStorage,
  newId,
  parseApiId,
  replaceLegacyUuids,
  toStorageId,
} from './ids.js';

const vectors = [
  {
    name: 'all-zero bytes',
    uuid: '00000000-0000-0000-0000-000000000000',
    api: '0000000000000000000000',
    storage: 'AAAAAAAAAAAAAAAAAAAAAA',
  },
  {
    name: 'leading zero bytes',
    uuid: '00000000-0000-0000-0000-000000000001',
    api: '0000000000000000000001',
    storage: 'AAAAAAAAAAAAAAAAAAAAAQ',
  },
  {
    name: 'mixed bytes',
    uuid: '00112233-4455-4677-8899-aabbccddeeff',
    api: '007pSo2b8iXeAjheKEVRdv',
    storage: 'ABEiM0RVRneImaq7zN3u_w',
  },
  {
    name: 'all-0xff bytes',
    uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    api: '7n42DGM5Tflk9n8mt7Fhc7',
    storage: '_____________________w',
  },
];
const mixed = vectors[2]!;
const invalidApiInputs = [
  '',
  'initialize',
  '0'.repeat(21),
  '0'.repeat(23),
  ` ${mixed.api}`,
  `${mixed.api} `,
  `${mixed.api}\n`,
  '_'.repeat(22),
  '-'.repeat(22),
  'é'.repeat(22),
  mixed.storage,
  '00112233445546778899aabbccddeeff',
  '{00112233-4455-4677-8899-aabbccddeeff}',
  '00112233-4455-4677-8899-aabbccddeefg',
  '7n42DGM5Tflk9n8mt7Fhc8', // Exactly 2^128, one beyond the maximum identifier.
  'z'.repeat(22),
];

describe('identifier encodings', () => {
  it.each(vectors)('preserves $name in fixed-width API and storage round trips', ({ uuid, api, storage }) => {
    expect(parseApiId(uuid)).toBe(api);
    expect(parseApiId(api)).toBe(api);
    expect(toStorageId(uuid)).toBe(storage);
    expect(toStorageId(api)).toBe(storage);
    expect(fromStorageId(storage)).toBe(api);
    expect(fromStorageId(toStorageId(api)!)).toBe(api);
    expect(toStorageId(fromStorageId(storage))).toBe(storage);
    expect(legacyUuidToApi(uuid)).toBe(api);
    expect(legacyUuidToStorage(uuid)).toBe(storage);
    expect(apiIdToLegacyUuid(api)).toBe(uuid);
    expect(parseApiId(apiIdToLegacyUuid(api)!)).toBe(api);
  });

  it('normalizes canonical uppercase legacy UUID input', () => {
    const uppercase = '00112233-4455-4677-8899-AABBCCDDEEFF';
    expect(parseApiId(uppercase)).toBe(mixed.api);
    expect(toStorageId(uppercase)).toBe(mixed.storage);
    expect(legacyUuidToApi(uppercase)).toBe(mixed.api);
    expect(legacyUuidToStorage(uppercase)).toBe(mixed.storage);
  });

  it.each(invalidApiInputs)('rejects invalid API input %j without truncation or coercion', (value) => {
    expect(parseApiId(value)).toBeNull();
    expect(toStorageId(value)).toBeNull();
    expect(apiIdToLegacyUuid(value)).toBeNull();
  });

  it('only resolves API ids to legacy artifact UUIDs, not UUID or storage input', () => {
    expect(apiIdToLegacyUuid(mixed.uuid)).toBeNull();
    expect(apiIdToLegacyUuid(mixed.uuid.toUpperCase())).toBeNull();
    expect(apiIdToLegacyUuid(mixed.storage)).toBeNull();
  });

  it.each([
    '',
    'A'.repeat(21),
    'A'.repeat(23),
    'AAAAAAAAAAAAAAAAAAAAAA==',
    '+++++++++++++++++++++w',
    '/////////////////////w',
    'AAAAAAAAAAAAAAAAAAAAA=',
    'AAAAAAAAAAAAAAAAAAAAAB', // Nonzero unused trailing bits alias the all-zero UUID.
    'AAAAAAAAAAAAAAAAAAAAAR', // Nonzero unused trailing bits alias the UUID ending in 01.
    '_____________________z', // Nonzero unused trailing bits alias the all-0xff UUID.
    'AAAAAAAAAAAAAAAAAAAAAé',
    ` ${mixed.storage}`,
    `${mixed.storage}\n`,
    mixed.uuid,
  ])('rejects corrupt or noncanonical SQLite storage input %j', (stored) => {
    expect(() => fromStorageId(stored)).toThrow();
  });

  it('accepts each canonical base64url trailing character', () => {
    expect(fromStorageId('AAAAAAAAAAAAAAAAAAAAAA')).toBe('0000000000000000000000');
    expect(fromStorageId('AAAAAAAAAAAAAAAAAAAAAQ')).toBe('0000000000000000000001');
    expect(fromStorageId('AAAAAAAAAAAAAAAAAAAAAg')).toBe('0000000000000000000002');
    expect(fromStorageId('AAAAAAAAAAAAAAAAAAAAAw')).toBe('0000000000000000000003');
  });

  it('generates API identifiers containing UUID v4 version and RFC variant bytes', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(parseApiId(id)).toBe(id);
    const stored = toStorageId(id)!;
    const bytes = Buffer.from(stored, 'base64url');
    expect(bytes).toHaveLength(16);
    expect(bytes[6]! >> 4).toBe(4);
    expect(bytes[8]! >> 6).toBe(2);
    expect(fromStorageId(stored)).toBe(id);
  });
});

describe('legacy identifier document rewriting', () => {
  it.each([
    { name: 'storage', encode: legacyUuidToStorage, expected: mixed.storage },
    { name: 'API', encode: legacyUuidToApi, expected: mixed.api },
  ])('rewrites repeated and uppercase UUIDs to $name without changing other document text', ({ encode, expected }) => {
    const document = JSON.stringify({
      id: mixed.uuid,
      nested: [mixed.uuid.toUpperCase(), { text: `Job-Id: ${mixed.uuid}\ninitialize` }],
      trailer: 'initialize',
      api: mixed.api,
      storage: mixed.storage,
      malformed: '00112233-4455-4677-8899-aabbccddeefg',
      url: 'https://example.com/wiki/non-uuid',
    });
    expect(replaceLegacyUuids(document, encode)).toBe(JSON.stringify({
      id: expected,
      nested: [expected, { text: `Job-Id: ${expected}\ninitialize` }],
      trailer: 'initialize',
      api: mixed.api,
      storage: mixed.storage,
      malformed: '00112233-4455-4677-8899-aabbccddeefg',
      url: 'https://example.com/wiki/non-uuid',
    }));
  });

  it.each(['', 'initialize', mixed.api, mixed.storage, '00112233445546778899aabbccddeeff'])
    ('leaves non-UUID value %j intact in legacy conversion helpers', (value) => {
      expect(legacyUuidToStorage(value)).toBe(value);
      expect(legacyUuidToApi(value)).toBe(value);
    });
});

describe('identifier input schema', () => {
  it.each(vectors)('normalizes legacy $name input and preserves API input', ({ uuid, api }) => {
    expect(idSchema.parse(uuid)).toBe(api);
    expect(idSchema.parse(api)).toBe(api);
  });

  it('normalizes uppercase legacy UUIDs', () => {
    expect(idSchema.parse('00112233-4455-4677-8899-AABBCCDDEEFF')).toBe(mixed.api);
  });

  it.each([...invalidApiInputs, null, undefined, 42, {}, []].map((value) => ({ value })))
    ('rejects invalid identifier $value', ({ value }) => {
      expect(idSchema.safeParse(value).success).toBe(false);
    });
});
