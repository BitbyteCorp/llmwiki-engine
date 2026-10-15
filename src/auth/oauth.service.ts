import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { CONFIG, DB } from '../common/tokens.js';
import { LoginRequestsService } from './login-requests.service.js';
import type { AuthFlow } from './google-oidc.types.js';
import { UsersService } from './users.service.js';
import { OAuthRepository } from './oauth.repository.js';
import { field, metadata, redirectRegistered } from './oauth.dto.js';
import { OAuthFailure, type ClientMetadata } from './oauth.types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const pkce = (value: string) => createHash('sha256').update(value).digest('base64url');

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) && a < 224;
  }
  // Public IPv6 global unicast only; excludes local, link-local and IPv4-mapped addresses.
  return /^[23][0-9a-f]{0,3}:/i.test(address);
}
async function fetchDocument(url: URL, test: boolean): Promise<unknown> {
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (test && url.protocol === 'http:'))) {
    throw new OAuthFailure('invalid_client', 'CIMD client_id must be an HTTPS URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || (!test && addresses.some(({ address }) => !publicAddress(address)))) {
    throw new OAuthFailure('invalid_client', 'CIMD must use public network addresses');
  }
  const address = addresses[0];
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { accept: 'application/json' },
      // Pin the checked address so a second DNS resolution cannot rebind to a private host.
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new OAuthFailure('invalid_client', 'CIMD fetch must return 200 without redirects')); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) { request.destroy(new OAuthFailure('invalid_client', 'CIMD exceeds 64 KiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new OAuthFailure('invalid_client', 'CIMD is not JSON')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new OAuthFailure('invalid_client', 'CIMD fetch timed out')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

@Injectable()
export class OAuthService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
    private readonly loginRequests: LoginRequestsService,
    private readonly repository: OAuthRepository,
  ) {}

  issuerUrl(): string {
    return this.config.publicUrl.replace(/\/$/, '');
  }

  resourceUrl(): string {
    return new URL('/mcp', this.config.publicUrl).href;
  }

  protectedResourceMetadata() {
    return { resource: this.resourceUrl(), authorization_servers: [this.issuerUrl()], scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'], resource_name: 'llmwiki-engine' };
  }

  authorizationServerMetadata() {
    const endpoint = (path: string) => new URL(path, this.config.publicUrl).href;
    return { issuer: this.issuerUrl(), authorization_endpoint: endpoint('/oauth/authorize'), token_endpoint: endpoint('/oauth/token'),
      registration_endpoint: endpoint('/oauth/register'), revocation_endpoint: endpoint('/oauth/revoke'),
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'], client_id_metadata_document_supported: true };
  }

  private async getClient(id: string): Promise<ClientMetadata> {
    const row = this.repository.getClient(id);
    if (row && (row.kind === 'dcr' || (row.expires_at && row.expires_at > new Date().toISOString()))) {
      return JSON.parse(row.metadata) as ClientMetadata;
    }
    let url: URL;
    try { url = new URL(id); } catch { throw new OAuthFailure('invalid_client', 'Unknown client'); }
    try {
      const document = await fetchDocument(url, this.config.nodeEnv === 'test');
      if (!document || typeof document !== 'object' || (document as Record<string, unknown>).client_id !== id) {
        throw new OAuthFailure('invalid_client', 'CIMD client_id must equal document URL');
      }
      const client = metadata(document, id);
      this.repository.cacheClient(client, expiry(3600));
      return client;
    } catch (error) {
      if (error instanceof OAuthFailure) throw error;
      throw new OAuthFailure('invalid_client', 'Unable to retrieve client metadata');
    }
  }

  private issueTokens(clientId: string, userId: number, resource: string, familyId = random()) {
    const access = random();
    const refresh = random();
    this.repository.insertTokens(
      { token_hash: hash(access), client_id: clientId, user_id: userId, family_id: familyId, resource, expires_at: expiry(3600) },
      { token_hash: hash(refresh), client_id: clientId, user_id: userId, family_id: familyId, resource, expires_at: expiry(30 * 86400) },
    );
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'mcp' };
  }

  finishAuthorization(userId: number, flow: Extract<AuthFlow, { kind: 'mcp' }>): string {
    const code = random();
    this.repository.insertCode(hash(code), { client_id: flow.clientId, user_id: userId, redirect_uri: flow.redirectUri,
      challenge: flow.challenge, resource: flow.resource, expires_at: expiry(300) });
    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set('code', code);
    if (flow.state !== undefined) redirect.searchParams.set('state', flow.state);
    redirect.searchParams.set('iss', this.issuerUrl());
    return redirect.href;
  }

  register(input: unknown): ClientMetadata {
    const client = metadata(input, random());
    client.client_id_issued_at = Math.floor(Date.now() / 1000);
    this.repository.registerClient(client);
    return client;
  }

  async authorize(req: Request, res: Response): Promise<void> {
    const id = field(req.query, 'client_id');
    const client = await this.getClient(id);
    const redirect = field(req.query, 'redirect_uri');
    if (!redirectRegistered(client.redirect_uris, redirect)) throw new OAuthFailure('invalid_request', 'redirect_uri is not registered');
    try {
      if (field(req.query, 'response_type') !== 'code') throw new OAuthFailure('unsupported_response_type', 'Use code');
      if (field(req.query, 'code_challenge_method') !== 'S256') throw new OAuthFailure('invalid_request', 'PKCE S256 is required');
      const challenge = field(req.query, 'code_challenge');
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthFailure('invalid_request', 'Invalid S256 challenge');
      const resource = field(req.query, 'resource');
      if (resource !== this.resourceUrl()) throw new OAuthFailure('invalid_target', 'Unknown resource');
      const scope = field(req.query, 'scope', true);
      if (scope && scope.split(' ').some((s) => s !== 'mcp')) throw new OAuthFailure('invalid_scope', 'Only mcp scope is supported');
      const state = field(req.query, 'state', true);
      const request = this.loginRequests.create(req, res, {
        kind: 'mcp', clientId: id, redirectUri: redirect, challenge, resource, ...(state ? { state } : {}),
      });
      res.redirect(`/login?request=${encodeURIComponent(request)}`);
    } catch (error) {
      // Once the client and exact redirect URI are trusted, OAuth errors go back to that client.
      const target = new URL(redirect);
      target.searchParams.set('error', error instanceof OAuthFailure ? error.code : 'server_error');
      if (error instanceof OAuthFailure) target.searchParams.set('error_description', error.message);
      if (typeof req.query.state === 'string') target.searchParams.set('state', req.query.state);
      target.searchParams.set('iss', this.issuerUrl());
      res.redirect(target.href);
    }
  }

  async token(input: unknown) {
    const id = field(input, 'client_id');
    await this.getClient(id);
    const grant = field(input, 'grant_type');
    const requestedResource = field(input, 'resource', true);
    if (requestedResource && requestedResource !== this.resourceUrl()) throw new OAuthFailure('invalid_target', 'Unknown resource');
    if (grant === 'authorization_code') {
      const code = field(input, 'code');
      const verifier = field(input, 'code_verifier');
      const redirect = field(input, 'redirect_uri');
      return this.db.transaction(() => {
        const row = this.repository.getCode(hash(code));
        if (!row || row.client_id !== id || row.redirect_uri !== redirect || row.expires_at <= new Date().toISOString() ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkce(verifier) !== row.challenge || !this.users.getById(row.user_id)) {
          throw new OAuthFailure('invalid_grant', 'Invalid authorization code or PKCE verifier');
        }
        this.repository.deleteCode(hash(code));
        return this.issueTokens(id, row.user_id, row.resource);
      })();
    }
    if (grant === 'refresh_token') {
      const token = field(input, 'refresh_token');
      const scope = field(input, 'scope', true);
      if (scope && scope !== 'mcp') throw new OAuthFailure('invalid_scope', 'Only mcp scope is supported');
      return this.db.transaction(() => {
        const row = this.repository.getRefreshToken(hash(token));
        if (!row || row.client_id !== id || row.revoked || row.expires_at <= new Date().toISOString() || !this.users.getById(row.user_id)) {
          throw new OAuthFailure('invalid_grant', 'Invalid refresh token');
        }
        this.repository.revokeRefreshToken(hash(token));
        return this.issueTokens(id, row.user_id, row.resource, row.family_id);
      })();
    }
    throw new OAuthFailure('unsupported_grant_type', 'Unsupported grant type');
  }

  async revoke(input: unknown): Promise<void> {
    const id = field(input, 'client_id');
    await this.getClient(id);
    this.repository.revoke(hash(field(input, 'token')), id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.repository.getAccessToken(hash(token));
    if (!row || row.revoked || row.expires_at <= new Date().toISOString()) throw new InvalidTokenError('Invalid or expired engine token');
    const user = this.users.getById(row.user_id);
    if (!user) throw new InvalidTokenError('User no longer exists');
    const client = this.repository.getClient(row.client_id);
    const clientName = client ? (JSON.parse(client.metadata) as ClientMetadata).client_name : undefined;
    return { token, clientId: row.client_id, scopes: ['mcp'], expiresAt: Date.parse(row.expires_at) / 1000,
      resource: new URL(row.resource), extra: { userId: user.id, clientName: clientName || row.client_id } };
  }
}
