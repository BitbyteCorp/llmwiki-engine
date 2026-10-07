import { lookup } from 'node:dns/promises';
import { createServer, request, type Server, type RequestOptions, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSource } from './safe-fetch.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
async function transport(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const pinned: string[] = [];
  const factory = ((url: URL, opts: RequestOptions, callback: (res: IncomingMessage) => void) => {
    opts.lookup!('source.test', { all: false }, (_error, address) => { pinned.push(address as string); });
    return request(`http://127.0.0.1:${port}${url.pathname}`, { ...opts, lookup: undefined }, callback);
  }) as typeof request;
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup;
  return { request: factory, resolve, pinned };
}
describe('protected remote source fetching', () => {
  it.each(['http://127.0.0.1', 'http://10.0.0.1', 'http://169.254.169.254', 'http://172.16.0.1', 'http://192.168.1.1', 'http://100.100.100.200', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://2130706433', 'http://metadata.google.internal', 'http://localhost'])('blocks private or metadata destination %s', async (url) => {
    await expect(fetchSource(url)).rejects.toMatchObject({ code: 'unsafe_source' });
  });
  it.each(['file:///etc/passwd', 'ftp://example.com/a', 'gopher://example.com/a', 'https://user:pass@example.com'])('rejects unsupported scheme or credentials %s', async (url) => {
    await expect(fetchSource(url)).rejects.toMatchObject({ code: 'unsafe_source' });
  });
  it('rejects a mixed public/private DNS answer before connecting', async () => {
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]) as unknown as typeof lookup;
    await expect(fetchSource('https://source.test', { resolve: resolver })).rejects.toMatchObject({ code: 'unsafe_source' });
  });
  it('pins the DNS answer and preserves the returned body', async () => {
    const options = await transport((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('Trusted bytes'); });
    const source = await fetchSource('http://source.test/article', options);
    expect(source.buffer.toString()).toBe('Trusted bytes');
    expect(source.url).toBe('http://source.test/article');
    expect(options.pinned).toEqual(['93.184.216.34']);
    expect(options.resolve).toHaveBeenCalledTimes(1);
  });
  it.each(['http://169.254.169.254/latest/meta-data', 'http://[::1]/admin', 'file:///etc/passwd'])('rechecks redirect destination %s', async (location) => {
    const options = await transport((_req, res) => { res.writeHead(302, { location }); res.end(); });
    await expect(fetchSource('http://source.test/article', options)).rejects.toMatchObject({ code: 'unsafe_source' });
    expect(options.pinned).toEqual(['93.184.216.34']);
  });
  it('rejects redirects that resolve to private addresses', async () => {
    const options = await transport((_req, res) => { res.writeHead(302, { location: 'http://next.test/private' }); res.end(); });
    options.resolve = vi.fn(async (host: string) => [{ address: host === 'source.test' ? '93.184.216.34' : '192.168.0.1', family: 4 }]) as unknown as typeof lookup;
    await expect(fetchSource('http://source.test/article', options)).rejects.toMatchObject({ code: 'unsafe_source' });
  });
  it.each([true, false])('caps %s content-length and streamed bytes', async (declared) => {
    const options = await transport((_req, res) => { res.setHeader('content-type', 'text/plain'); if (declared) res.setHeader('content-length', 20); else res.setHeader('transfer-encoding', 'chunked'); res.end('12345678901234567890'); });
    await expect(fetchSource('http://source.test/large', { ...options, maxBytes: 10 })).rejects.toMatchObject({ code: 'source_too_large' });
  });
  it('rejects unknown content types and compressed bodies', async () => {
    const options = await transport((req, res) => { res.setHeader('content-type', req.url === '/binary' ? 'application/octet-stream' : 'text/plain'); if (req.url === '/compressed') res.setHeader('content-encoding', 'gzip'); res.end('not accepted'); });
    await expect(fetchSource('http://source.test/binary', options)).rejects.toMatchObject({ code: 'source_type' });
    await expect(fetchSource('http://source.test/compressed', options)).rejects.toMatchObject({ code: 'source_type' });
  });
  it('bounds total time including DNS', async () => {
    const resolver = (() => new Promise(() => {})) as unknown as typeof lookup;
    await expect(fetchSource('http://source.test', { resolve: resolver, timeoutMs: 10 })).rejects.toThrow('timed out');
  });
});
