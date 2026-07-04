/**
 * Cloudflare Access identity resolution.
 *
 * Access is authentication; document tokens remain authorization
 * (docs/adr/2026-07-access-authn-document-tokens-authz.md). Every request
 * arriving through Access carries a JWT that we verify here — signature
 * against the team's public certs, audience, issuer, expiry. Headers are
 * never trusted bare: a DNS/origin bypass cannot forge identity.
 *
 * Identity kinds:
 *  - human: an SSO user (JWT carries their email)
 *  - agent: an Access service token (JWT carries the token's common_name)
 *
 * Dev mode: when ACCESS_TEAM_DOMAIN is configured, dev injection is
 * structurally unreachable. Only when Access is NOT configured AND
 * PROOF_DEV_MODE=1 do we mint a dev identity (for `wrangler dev`).
 * With neither configured, every request is rejected.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export type Identity =
  | { kind: 'human'; email: string; source: 'access' | 'dev' }
  | { kind: 'agent'; serviceTokenId: string; source: 'access' | 'dev' };

export interface AccessEnv {
  /** Access team domain, e.g. "your-team.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application AUD tag. */
  ACCESS_AUD?: string;
  /** "1" enables dev identity injection — ignored when Access is configured. */
  PROOF_DEV_MODE?: string;
  /** Dev-mode human identity, e.g. "dev@example.com". */
  DEV_IDENTITY?: string;
}

const JWT_HEADER = 'cf-access-jwt-assertion';
const JWT_COOKIE = 'CF_Authorization';

/** One JWKS fetcher per team domain, cached for the isolate's lifetime. */
const jwksCache = new Map<string, JWTVerifyGetKey>();

function getAccessJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

function extractToken(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER);
  if (header) return header;
  const cookies = request.headers.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === JWT_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Verify an Access JWT and map its claims to an Identity.
 * `getKey` is injectable for tests; production uses the team JWKS.
 */
export async function verifyAccessJwt(
  token: string,
  cfg: { teamDomain: string; aud: string },
  getKey?: JWTVerifyGetKey,
): Promise<Identity | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      getKey ?? getAccessJwks(cfg.teamDomain),
      {
        audience: cfg.aud,
        issuer: `https://${cfg.teamDomain}`,
      },
    );
    if (typeof payload.email === 'string' && payload.email.length > 0) {
      return { kind: 'human', email: payload.email, source: 'access' };
    }
    // Service-token JWTs carry the token's client id as common_name.
    if (
      typeof payload.common_name === 'string' &&
      payload.common_name.length > 0
    ) {
      return {
        kind: 'agent',
        serviceTokenId: payload.common_name,
        source: 'access',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the request identity, or null when the request must be rejected.
 * `getKey` is injectable for tests.
 */
export async function resolveIdentity(
  request: Request,
  env: AccessEnv,
  getKey?: JWTVerifyGetKey,
): Promise<Identity | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();

  if (teamDomain && aud) {
    const token = extractToken(request);
    if (!token) return null;
    return verifyAccessJwt(token, { teamDomain, aud }, getKey);
  }

  // Access not configured: dev injection only with the explicit flag.
  // Explicit headers win over the DEV_IDENTITY env fallback.
  if (env.PROOF_DEV_MODE === '1') {
    const humanHeader = request.headers.get('x-dev-identity');
    if (humanHeader && humanHeader.includes('@')) {
      return { kind: 'human', email: humanHeader, source: 'dev' };
    }
    const agentHeader = request.headers.get('x-dev-agent');
    if (agentHeader) {
      return { kind: 'agent', serviceTokenId: agentHeader, source: 'dev' };
    }
    if (env.DEV_IDENTITY && env.DEV_IDENTITY.includes('@')) {
      return { kind: 'human', email: env.DEV_IDENTITY, source: 'dev' };
    }
    return null;
  }

  return null;
}

export function unauthorized(env: AccessEnv): Response {
  const configured = Boolean(env.ACCESS_TEAM_DOMAIN?.trim() && env.ACCESS_AUD?.trim());
  return Response.json(
    {
      success: false,
      error: configured
        ? 'unauthorized: missing or invalid Access credentials'
        : 'unauthorized: Access is not configured and dev mode is off (set ACCESS_TEAM_DOMAIN/ACCESS_AUD, or PROOF_DEV_MODE=1 locally)',
    },
    { status: 401 },
  );
}
