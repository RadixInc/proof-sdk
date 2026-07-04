/**
 * Collab session tokens: short-lived HMAC-SHA256-signed claims minted by the
 * Worker and verified inside the document DO at WebSocket connect. Mirrors
 * upstream signCollabClaims/verifyCollabToken semantics (slug, role, expiry,
 * access epoch) with WebCrypto.
 */

import type { ResolvedRole } from './util';

export interface CollabClaims {
  slug: string;
  role: ResolvedRole;
  /** Identity string for presence/attribution (email or agent id). */
  sub: string;
  /** Unix seconds. */
  exp: number;
  /** Document access epoch; bumped epochs invalidate outstanding tokens. */
  epoch: number;
}

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Resolve the signing secret. Deployed instances must set
 * PROOF_COLLAB_SIGNING_SECRET; a fixed dev secret is allowed only under
 * PROOF_DEV_MODE=1 (same invariant as dev identity injection).
 */
export function resolveCollabSigningSecret(env: {
  PROOF_COLLAB_SIGNING_SECRET?: string;
  PROOF_DEV_MODE?: string;
}): string | null {
  const configured = env.PROOF_COLLAB_SIGNING_SECRET?.trim();
  if (configured) return configured;
  if (env.PROOF_DEV_MODE === '1') return 'proof-dev-collab-signing-secret';
  return null;
}

export async function signCollabToken(
  secret: string,
  claims: CollabClaims,
): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyCollabToken(
  secret: string,
  token: string,
  expected: { slug: string; epoch: number },
): Promise<CollabClaims | null> {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig) as unknown as ArrayBuffer,
      encoder.encode(payload),
    );
    if (!valid) return null;
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payload)),
    ) as CollabClaims;
    if (claims.slug !== expected.slug) return null;
    if (claims.epoch !== expected.epoch) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    if (!claims.role) return null;
    return claims;
  } catch {
    return null;
  }
}
