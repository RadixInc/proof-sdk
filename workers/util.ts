/** Shared utilities for the Workers implementation. */

/** SHA-256 hex digest — matches upstream server/db.ts hashSecret. */
export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_LENGTH = 8;

/**
 * 8-char slug over [a-z0-9], matching upstream server/slug.ts (including
 * per-byte mod-36 mapping). Collision handling is the caller's job via the
 * D1 unique constraint + retry.
 */
export function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  let slug = '';
  for (const byte of bytes) {
    slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}

/**
 * Strip ephemeral collab cursor spans from markdown before storing.
 * Ported verbatim from upstream server/collab.ts stripEphemeralCollabSpans.
 */
export function stripEphemeralCollabSpans(markdown: string): string {
  if (!markdown || markdown.indexOf('<span') === -1) return markdown;

  const cursorSpanPattern =
    /<span\b[^>]*(?:ProseMirror-yjs-cursor|proof-collab-cursor|proof-agent-cursor|data-proof-cursor|data-agent-cursor)[^>]*>[\s\S]*?<\/span>/gi;
  let sanitized = markdown;
  let previous = '';
  while (sanitized !== previous) {
    previous = sanitized;
    sanitized = sanitized.replace(cursorSpanPattern, '');
  }

  // y-prosemirror cursor widgets use WORD JOINER separators (U+2060).
  sanitized = sanitized.replace(/⁠/g, '');

  return sanitized;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type ShareRole = 'viewer' | 'commenter' | 'editor';
export type ResolvedRole = ShareRole | 'owner_bot';

export function isShareRole(v: unknown): v is ShareRole {
  return v === 'viewer' || v === 'commenter' || v === 'editor';
}

/**
 * Public base URL, matching upstream server/public-base-url.ts precedence:
 * trusted proxy headers, then PROOF_PUBLIC_BASE_URL, then the request origin.
 */
export function getPublicBaseUrl(
  request: Request,
  env: { PROOF_TRUST_PROXY_HEADERS?: string; PROOF_PUBLIC_BASE_URL?: string },
): string {
  const trust = (env.PROOF_TRUST_PROXY_HEADERS ?? '').toLowerCase();
  if (trust === '1' || trust === 'true' || trust === 'yes') {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (proto && host) return `${proto}://${host}`;
  }
  const configured = env.PROOF_PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

/**
 * Constant-time string equality via the Workers runtime's
 * crypto.subtle.timingSafeEqual, so a configured secret (e.g. the direct-share
 * API key) can't be recovered through response-time measurement.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

/** Presented app-level secret, matching upstream getPresentedSecret order. */
export function getPresentedSecret(request: Request): string | null {
  const share = request.headers.get('x-share-token');
  if (share) return share.trim();
  const bridge = request.headers.get('x-bridge-token');
  if (bridge) return bridge.trim();
  const auth = request.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const token = new URL(request.url).searchParams.get('token');
  if (token) return token.trim();
  return null;
}
