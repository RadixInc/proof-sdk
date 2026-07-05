/**
 * API router: document create/read slice (issue #5).
 *
 * Routes (canonical + contract aliases, per AGENT_CONTRACT.md):
 *   POST /documents            — canonical create (JSON)
 *   POST /api/documents        — legacy create (PROOF_LEGACY_CREATE_MODE gate)
 *   POST /share/markdown       — direct share (JSON or raw markdown; auth mode)
 *   POST /api/share/markdown   — same
 *   GET  /documents/:slug/state, /api/agent/:slug/state — token-gated state
 *   GET  /documents/:slug, /api/documents/:slug         — lenient doc read
 */

import { canonicalizeStoredMarks } from '../src/formats/marks';
import type { Identity } from './access';
import { resolveCollabSigningSecret, signCollabToken } from './collab-token';
import type { DocumentDO } from './document-do';
import { buildProofSdkAgentDescriptor, buildProofSdkLinks } from './sdk-links';
import {
  generateSlug,
  getPresentedSecret,
  getPublicBaseUrl,
  hashSecret,
  isPlainObject,
  isShareRole,
  stripEphemeralCollabSpans,
} from './util';
import type { ShareRole } from './util';

export interface ApiEnv {
  DOCUMENT_DO: DurableObjectNamespace<DocumentDO>;
  DB: D1Database;
  PROOF_PUBLIC_BASE_URL?: string;
  PROOF_TRUST_PROXY_HEADERS?: string;
  PROOF_LEGACY_CREATE_MODE?: string;
  PROOF_SHARE_MARKDOWN_AUTH_MODE?: string;
  PROOF_SHARE_MARKDOWN_API_KEY?: string;
  PROOF_COLLAB_SIGNING_SECRET?: string;
  PROOF_DEV_MODE?: string;
  COLLAB_SESSION_TTL_SECONDS?: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // matches upstream express limits

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface CreateFields {
  markdown: unknown;
  marks?: unknown;
  title?: unknown;
  ownerId?: unknown;
  role: ShareRole;
}

async function createDocument(
  request: Request,
  env: ApiEnv,
  fields: CreateFields,
  opts: { directShare: boolean; deprecation?: Record<string, unknown> },
): Promise<Response> {
  if (typeof fields.markdown !== 'string') {
    const body: Record<string, unknown> = {
      error: 'markdown field is required',
      code: 'MISSING_MARKDOWN',
      fix: '{"markdown":"# Title\\n\\nHello"}',
    };
    if (opts.directShare) {
      body.hint =
        'Send JSON { "markdown": "..." } or send the raw markdown body as text/plain.';
    }
    return json(body, 400);
  }
  const markdown = stripEphemeralCollabSpans(fields.markdown);
  if (!markdown.trim()) {
    return json(
      {
        error: 'markdown must not be empty',
        code: 'EMPTY_MARKDOWN',
        fix: '{"markdown":"# Title\\n\\nHello"}',
      },
      400,
    );
  }
  if (markdown.length > MAX_BODY_BYTES) {
    return json({ error: 'Payload too large' }, 413);
  }
  if (fields.marks !== undefined && !isPlainObject(fields.marks)) {
    return json(
      { error: 'marks must be an object when provided', code: 'INVALID_MARKS' },
      400,
    );
  }
  const marks = canonicalizeStoredMarks(
    (fields.marks ?? {}) as Parameters<typeof canonicalizeStoredMarks>[0],
  );
  const title = typeof fields.title === 'string' ? fields.title : null;
  const ownerId = typeof fields.ownerId === 'string' ? fields.ownerId : null;

  const docId = crypto.randomUUID();
  const ownerSecret = crypto.randomUUID();
  const accessToken = crypto.randomUUID();
  const accessTokenId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const [ownerSecretHash, accessSecretHash] = await Promise.all([
    hashSecret(ownerSecret),
    hashSecret(accessToken),
  ]);

  // Claim a slug in D1 (unique constraint = collision handling), then create
  // the document DO. D1 row is the global index; the DO holds the content.
  let slug = '';
  let claimed = false;
  for (let attempt = 0; attempt < 5 && !claimed; attempt += 1) {
    slug = generateSlug();
    try {
      await env.DB.prepare(
        `INSERT INTO documents (slug, doc_id, title, share_state, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      )
        .bind(slug, docId, title, ownerId, createdAt, createdAt)
        .run();
      claimed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('UNIQUE')) throw err;
    }
  }
  if (!claimed) {
    return json({ error: 'Failed to allocate document slug' }, 500);
  }

  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const created = await stub.create({
    slug,
    docId,
    title,
    markdown,
    marksJson: JSON.stringify(marks),
    ownerId,
    ownerSecretHash,
    accessTokenId,
    accessSecretHash,
    accessRole: fields.role,
    createdAt,
  });
  if (!created.ok) {
    return json({ error: 'Failed to create document' }, 500);
  }

  const base = getPublicBaseUrl(request, env);
  const path = `/d/${slug}`;
  const shareUrl = base ? `${base}${path}` : path;
  const withToken = (u: string) => `${u}?token=${accessToken}`;

  const body: Record<string, unknown> = {
    success: true,
    slug,
    docId,
    url: path,
    shareUrl,
    tokenPath: withToken(path),
    tokenUrl: withToken(shareUrl),
    viewUrl: shareUrl,
    viewPath: path,
    ownerSecret,
    accessToken,
    accessRole: fields.role,
    active: true,
    shareState: 'ACTIVE',
    snapshotUrl: null,
    createdAt,
    _links: {
      view: path,
      web: shareUrl,
      tokenUrl: withToken(shareUrl),
      ...buildProofSdkLinks(slug, {
        includeMutationRoutes: true,
        includeBridgeRoutes: true,
      }),
    },
    agent: buildProofSdkAgentDescriptor(slug),
  };
  if (opts.directShare) {
    const links = body._links as Record<string, unknown>;
    links.comment = {
      method: 'POST',
      href: `/documents/${slug}/bridge/comments`,
      body: { text: 'Your comment', anchorText: 'text to attach to' },
    };
    links.suggest = {
      method: 'POST',
      href: `/documents/${slug}/bridge/suggestions`,
      body: { anchorText: 'text to replace', replacement: 'new text' },
    };
    links.rewrite = {
      method: 'POST',
      href: `/documents/${slug}/bridge/rewrite`,
      body: { markdown: '# Replacement document' },
    };
  }
  if (opts.deprecation) {
    body.deprecation = opts.deprecation;
  }
  return json(body);
}

function resolveLegacyCreateMode(env: ApiEnv, request: Request): string {
  const mode = env.PROOF_LEGACY_CREATE_MODE?.trim();
  if (mode === 'allow' || mode === 'warn' || mode === 'disabled') return mode;
  const host = new URL(request.url).hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return loopback ? 'allow' : 'warn';
}

async function handleCanonicalCreate(
  request: Request,
  env: ApiEnv,
  legacyPath: boolean,
): Promise<Response> {
  let deprecation: Record<string, unknown> | undefined;
  const headers: Record<string, string> = {};
  if (legacyPath) {
    const mode = resolveLegacyCreateMode(env, request);
    if (mode === 'disabled') {
      return json(
        {
          error: 'Legacy document create route is disabled on this server',
          code: 'LEGACY_CREATE_DISABLED',
          fix: 'Use POST /documents',
          docs: '/agent-docs',
          create: { method: 'POST', href: '/documents' },
        },
        410,
        {
          'x-proof-legacy-create': 'disabled',
          link: '</agent-docs>; rel="help"',
        },
      );
    }
    if (mode === 'warn') {
      headers.deprecation = 'true';
      headers.warning = '299 - "/api/documents is legacy; migrate to /documents"';
      headers['x-proof-legacy-create'] = 'warn';
      headers.link = '</agent-docs>; rel="help"';
      deprecation = {
        mode: 'warn',
        legacyPath: '/api/documents',
        canonicalPath: '/documents',
        fix: 'Use POST /documents',
        docs: '/agent-docs',
        create: { method: 'POST', href: '/documents' },
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(
      {
        error: 'markdown field is required',
        code: 'MISSING_MARKDOWN',
        fix: '{"markdown":"# Title\\n\\nHello"}',
      },
      400,
    );
  }
  const bodyObj = isPlainObject(parsed) ? parsed : {};
  const response = await createDocument(
    request,
    env,
    {
      markdown: bodyObj.markdown,
      marks: bodyObj.marks,
      title: bodyObj.title,
      ownerId: bodyObj.ownerId,
      role: 'editor', // canonical create always mints an editor token
    },
    { directShare: false, deprecation },
  );
  if (Object.keys(headers).length === 0 || response.status !== 200) {
    return response;
  }
  const merged = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) merged.headers.set(k, v);
  return merged;
}

// ---------------------------------------------------------------------------
// Direct share (/share/markdown)
// ---------------------------------------------------------------------------

function getDirectSharePresentedToken(request: Request): string | null {
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  const auth = request.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

function authorizeDirectShare(request: Request, env: ApiEnv): Response | null {
  let mode = env.PROOF_SHARE_MARKDOWN_AUTH_MODE?.trim() || 'none';
  if (mode === 'auto') mode = 'none';
  if (mode === 'none') return null;

  const apiKey = env.PROOF_SHARE_MARKDOWN_API_KEY?.trim();
  const presented = getDirectSharePresentedToken(request);
  if (mode === 'api_key' || mode === 'oauth_or_api_key') {
    if (!apiKey) {
      return json(
        {
          error:
            'Direct share auth is set to api_key but PROOF_SHARE_MARKDOWN_API_KEY is missing',
          code: 'DIRECT_SHARE_MISCONFIGURED',
        },
        503,
      );
    }
    if (presented === apiKey) return null;
    if (mode === 'api_key') {
      return json(
        {
          error: 'Unauthorized direct share request',
          code: 'UNAUTHORIZED',
          hint: 'Set Authorization: Bearer <PROOF_SHARE_MARKDOWN_API_KEY> or x-api-key.',
        },
        401,
      );
    }
  }
  // oauth / oauth_or_api_key without a matching key: OAuth is not part of
  // this fork (Access is authentication — see the access-authn ADR).
  return json(
    {
      error: 'OAuth is not available in Proof SDK. Use share tokens or an API key.',
      code: 'OAUTH_NOT_CONFIGURED',
    },
    503,
  );
}

async function handleShareMarkdown(request: Request, env: ApiEnv): Promise<Response> {
  const denied = authorizeDirectShare(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  let markdown: unknown;
  let bodyObj: Record<string, unknown> = {};
  if (contentType.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      parsed = {};
    }
    bodyObj = isPlainObject(parsed) ? parsed : {};
    markdown = bodyObj.markdown ?? bodyObj.content;
  } else {
    const text = await request.text();
    markdown = text.length > 0 ? text : undefined;
  }

  const roleRaw =
    bodyObj.accessRole ??
    bodyObj.defaultRole ??
    bodyObj.role ??
    url.searchParams.get('role') ??
    'editor';
  if (!isShareRole(roleRaw)) {
    return json(
      { error: 'role must be viewer, commenter, or editor', code: 'INVALID_ROLE' },
      400,
    );
  }

  return createDocument(
    request,
    env,
    {
      markdown,
      marks: bodyObj.marks,
      title: bodyObj.title ?? url.searchParams.get('title') ?? undefined,
      ownerId: bodyObj.ownerId ?? url.searchParams.get('ownerId') ?? undefined,
      role: roleRaw,
    },
    { directShare: true },
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadDocAndRole(request: Request, env: ApiEnv, slug: string) {
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const state = await stub.getState();
  if (!state) return { state: null, role: null } as const;
  const secret = getPresentedSecret(request);
  const role = secret ? await stub.resolveRole(await hashSecret(secret)) : null;
  return { state, role } as const;
}

async function handleState(request: Request, env: ApiEnv, slug: string): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (state.shareState === 'DELETED') {
    return json({ success: false, error: 'Document deleted' }, 410);
  }
  if (state.shareState === 'REVOKED' && role !== 'owner_bot') {
    return json({ success: false, error: 'Document access revoked' }, 403);
  }
  if (state.shareState === 'PAUSED' && role !== 'owner_bot') {
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  if (!role) {
    return json(
      {
        success: false,
        error: 'Missing or invalid share token',
        code: 'UNAUTHORIZED',
        acceptedHeaders: [
          'x-share-token: <ACCESS_TOKEN>',
          'x-bridge-token: <OWNER_SECRET>',
          'Authorization: Bearer <TOKEN>',
        ],
      },
      401,
    );
  }

  return json({
    success: true,
    slug: state.slug,
    docId: state.docId,
    title: state.title,
    shareState: state.shareState,
    content: state.markdown,
    markdown: state.markdown,
    marks: JSON.parse(state.marksJson),
    updatedAt: state.updatedAt,
    revision: state.revision,
    readSource: 'canonical_row',
    projectionFresh: true,
    repairPending: false,
    // Mutation routes land in later slices (issues #10/#11).
    mutationReady: false,
    capabilities: {
      snapshotV2: false,
      editV2: false,
      topLevelOnly: true,
      mutationReady: false,
      authoritativeMutations: false,
    },
    _links: {
      create: { method: 'POST', href: '/documents' },
      state: `/documents/${slug}/state`,
      agentState: `/api/agent/${slug}/state`,
      presence: { method: 'POST', href: `/documents/${slug}/presence` },
      events: `/documents/${slug}/events/pending?after=0`,
      docs: '/agent-docs',
    },
    agent: buildProofSdkAgentDescriptor(slug),
  });
}

/**
 * Ops probe (not part of AGENT_CONTRACT.md): asserts the stored projection
 * matches a replay of the durable Yjs state. Same authorization as /state.
 */
async function handleProjectionHealth(
  request: Request,
  env: ApiEnv,
  slug: string,
): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (!role) {
    return json(
      { success: false, error: 'Missing or invalid share token', code: 'UNAUTHORIZED' },
      401,
    );
  }
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const health = await stub.getProjectionHealth();
  if (!health) return json({ success: false, error: 'Document not found' }, 404);
  return json({ success: true, ...health });
}

async function handleDocRead(request: Request, env: ApiEnv, slug: string): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ error: 'Document not found' }, 404);
  if (state.shareState === 'DELETED') return json({ error: 'Document deleted' }, 410);
  const owner = role === 'owner_bot';
  if (state.shareState === 'REVOKED' && !owner) {
    return json({ error: 'Document access has been revoked' }, 403);
  }
  if (state.shareState === 'PAUSED' && !owner) {
    return json({ error: 'Document is not currently accessible' }, 403);
  }
  return json({
    slug: state.slug,
    docId: state.docId,
    title: state.title,
    markdown: state.markdown,
    marks: JSON.parse(state.marksJson),
    active: state.shareState === 'ACTIVE',
    shareState: state.shareState,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    viewers: [],
    _links: buildProofSdkLinks(slug, {
      includeMutationRoutes: true,
      includeBridgeRoutes: true,
    }),
    agent: buildProofSdkAgentDescriptor(slug),
  });
}

// ---------------------------------------------------------------------------
// Collab sessions
// ---------------------------------------------------------------------------

async function handleCollabSession(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (state.shareState !== 'ACTIVE' && role !== 'owner_bot') {
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  if (!role) {
    return json(
      {
        success: false,
        error: 'Missing or invalid share token',
        code: 'UNAUTHORIZED',
        acceptedHeaders: [
          'x-share-token: <ACCESS_TOKEN>',
          'x-bridge-token: <OWNER_SECRET>',
          'Authorization: Bearer <TOKEN>',
        ],
      },
      401,
    );
  }
  const secret = resolveCollabSigningSecret(env);
  if (!secret) {
    return json(
      {
        success: false,
        error:
          'Collab signing secret is not configured (set PROOF_COLLAB_SIGNING_SECRET)',
        code: 'COLLAB_MISCONFIGURED',
      },
      503,
    );
  }
  const ttl = Math.max(60, Number(env.COLLAB_SESSION_TTL_SECONDS ?? '600') || 600);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sub =
    identity.kind === 'human' ? identity.email : `agent:${identity.serviceTokenId}`;
  // Collab connections write through the editor; owner_bot maps to editor.
  const collabRole = role === 'owner_bot' ? 'editor' : role;
  const token = await signCollabToken(secret, {
    slug,
    role: collabRole,
    sub,
    exp,
    epoch: state.accessEpoch,
  });
  const base = getPublicBaseUrl(request, env);
  const wsBase = base.replace(/^http/, 'ws');
  return json({
    success: true,
    session: {
      slug,
      role: collabRole,
      token,
      collabWsUrl: `${wsBase}/documents/${slug}/collab`,
      expiresAt: new Date(exp * 1000).toISOString(),
      ttlSeconds: ttl,
    },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Returns null when the path is not an API route (falls through to assets). */
export async function handleApiRequest(
  request: Request,
  env: ApiEnv,
  _identity: Identity,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'POST' && (path === '/documents' || path === '/api/documents')) {
    return handleCanonicalCreate(request, env, path === '/api/documents');
  }
  if (
    method === 'POST' &&
    (path === '/share/markdown' || path === '/api/share/markdown')
  ) {
    return handleShareMarkdown(request, env);
  }

  const stateMatch = path.match(
    /^\/(?:documents|api\/agent)\/([a-z0-9-]+)\/state$/,
  );
  if (method === 'GET' && stateMatch) {
    return handleState(request, env, stateMatch[1]);
  }

  const healthMatch = path.match(/^\/documents\/([a-z0-9-]+)\/projection-health$/);
  if (method === 'GET' && healthMatch) {
    return handleProjectionHealth(request, env, healthMatch[1]);
  }

  const collabSessionMatch = path.match(
    /^\/(?:api\/)?documents\/([a-z0-9-]+)\/collab-(session|refresh)$/,
  );
  if (
    collabSessionMatch &&
    ((method === 'GET' && collabSessionMatch[2] === 'session') ||
      (method === 'POST' && collabSessionMatch[2] === 'refresh'))
  ) {
    return handleCollabSession(request, env, collabSessionMatch[1], _identity);
  }

  const docMatch = path.match(/^\/(?:api\/)?documents\/([a-z0-9-]+)$/);
  if (method === 'GET' && docMatch) {
    return handleDocRead(request, env, docMatch[1]);
  }

  return null;
}
