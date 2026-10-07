export interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
  client_id_issued_at?: number;
}

export interface TokenRow {
  token_hash: string;
  client_id: string;
  user_id: number;
  family_id: string;
  resource: string;
  expires_at: string;
  revoked: number;
}

export interface AuthorizationCodeRow {
  client_id: string;
  user_id: number;
  redirect_uri: string;
  challenge: string;
  resource: string;
  expires_at: string;
}

export class OAuthFailure extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}
