import type { ClientMetadata } from './oauth.types.js';
import { OAuthFailure } from './oauth.types.js';

export function field(source: unknown, key: string, optional = false): string {
  const value = source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value) throw new OAuthFailure('invalid_request', `${key} is required`);
  return value;
}

function validRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash && (u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
}
export function metadata(input: unknown, clientId: string): ClientMetadata {
  if (!input || typeof input !== 'object') throw new OAuthFailure('invalid_client_metadata', 'Client metadata must be an object');
  const data = input as Record<string, unknown>;
  if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0 || data.redirect_uris.length > 20 ||
    !data.redirect_uris.every((uri) => typeof uri === 'string' && validRedirect(uri))) {
    throw new OAuthFailure('invalid_redirect_uri', 'Register 1–20 HTTPS or loopback HTTP redirect URIs');
  }
  if (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none') {
    throw new OAuthFailure('invalid_client_metadata', 'Only public clients (none) are supported');
  }
  if (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || data.grant_types.some((g) => !['authorization_code', 'refresh_token'].includes(String(g))))) {
    throw new OAuthFailure('invalid_client_metadata', 'Unsupported grant type');
  }
  if (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.some((r) => r !== 'code'))) {
    throw new OAuthFailure('invalid_client_metadata', 'Only code responses are supported');
  }
  if (data.client_name !== undefined && (typeof data.client_name !== 'string' || data.client_name.length > 200)) {
    throw new OAuthFailure('invalid_client_metadata', 'Invalid client name');
  }
  return { client_id: clientId, ...(typeof data.client_name === 'string' ? { client_name: data.client_name } : {}),
    redirect_uris: [...new Set(data.redirect_uris as string[])], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
}
