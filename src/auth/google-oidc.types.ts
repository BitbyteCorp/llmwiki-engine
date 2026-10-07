export type AuthFlow =
  | { kind: 'web'; next: string }
  | { kind: 'mcp'; clientId: string; redirectUri: string; challenge: string; resource: string; state?: string };

export interface GoogleIssuer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}
