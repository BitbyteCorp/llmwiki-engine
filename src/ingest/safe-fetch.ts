import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { ApiError } from '../api/api-error.js';

export const SOURCE_BYTES = 20 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
const allowedTypes: Record<string, true> = { 'text/html': true, 'application/xhtml+xml': true, 'text/plain': true, 'text/markdown': true, 'application/pdf': true };
const blocked = (message: string): never => { throw new ApiError(400, 'unsafe_source', message); };

/** Only globally routable addresses are eligible, including every DNS answer. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const at = normalized.lastIndexOf(':');
    const octets = normalized.slice(at + 1).split('.').map(Number);
    normalized = `${normalized.slice(0, at)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [left, right] = normalized.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const words = right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
  const values = words.map((word) => Number.parseInt(word, 16));
  // Reject mapped IPv4, ULA, link-local, multicast, NAT64 and non-global ranges.
  if (values.length !== 8 || values[0]! < 0x2000 || values[0]! > 0x3fff) return false;
  // IETF assignments, documentation, Teredo and 6to4 can tunnel to private addresses.
  return !(values[0] === 0x2002 || (values[0] === 0x2001 && (values[1]! < 0x200 || values[1] === 0xdb8)) ||
    (values[0] === 0x3fff && values[1]! < 0x1000));
}

export interface RemoteSource { buffer: Buffer; mediaType: string; url: string }
export interface FetchOptions {
  maxBytes?: number; timeoutMs?: number;
  resolve?: typeof lookup;
  request?: typeof httpRequest;
}

export async function fetchSource(input: string, options: FetchOptions = {}): Promise<RemoteSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? SOURCE_BYTES;
  try {
    let url = new URL(input);
    for (let redirects = 0; ; redirects++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) blocked('Only credential-free HTTP(S) URLs are allowed');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata.google.internal') blocked('Local and metadata hosts are not allowed');
      const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        (options.resolve ?? lookup)(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error('Source request timed out'));
          else controller.signal.addEventListener('abort', () => reject(new Error('Source request timed out')), { once: true });
        }),
      ]);
      if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) blocked('Source resolves to a non-public address');
      const pinned = answers[0]!;
      const response = await new Promise<{ location?: string; source?: RemoteSource }>((resolve, reject) => {
        const request = options.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
        const requestOptions: RequestOptions = {
          signal: controller.signal, headers: { accept: Object.keys(allowedTypes).join(', '), 'accept-encoding': 'identity', 'user-agent': 'llmwiki-ingest/1' },
          // Keep the hostname for Host and TLS/SNI, but never resolve it a second time.
          lookup: (_host, opts, callback) => {
            if (typeof opts === 'object' && opts.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
            else callback(null, pinned.address, pinned.family);
          },
        };
        const req = request(url, requestOptions, (res) => {
          const fail = (error: Error) => { res.destroy(); reject(error); };
          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location;
            res.destroy();
            if (!location || redirects >= 5) reject(new ApiError(400, 'unsafe_source', 'Invalid or excessive redirects'));
            else resolve({ location });
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { fail(new ApiError(400, 'source_http_error', `Source returned HTTP ${res.statusCode}`)); return; }
          const mediaType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (!Object.hasOwn(allowedTypes, mediaType) || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) { fail(new ApiError(400, 'source_type', 'Unsupported source content type or encoding')); return; }
          if (Number(res.headers['content-length'] ?? 0) > maxBytes) { fail(new ApiError(413, 'source_too_large', 'Source exceeds the byte limit')); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) fail(new ApiError(413, 'source_too_large', 'Source exceeds the byte limit'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve({ source: { buffer: Buffer.concat(chunks, size), mediaType, url: url.href } }));
        });
        req.on('error', reject);
        req.end();
      });
      if (response.source) return response.source;
      url = new URL(response.location!, url);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'source_fetch_failed', controller.signal.aborted ? 'Source request timed out' : 'Source could not be fetched');
  } finally { clearTimeout(timer); }
}
