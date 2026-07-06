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

import { getServerByName } from 'partyserver';
import { canonicalizeStoredMarks } from '../src/formats/marks';
import type { Identity } from './access';
import { resolveCollabSigningSecret, signCollabToken } from './collab-token';
import type { DocumentDO } from './document-do';
import { buildProofSdkAgentDescriptor, buildProofSdkLinks } from './sdk-links';
import { renderSnapshotHtml, snapshotObjectKey, snapshotPublicPath } from './snapshot';
import { queryLibrary, recordVisit, renderLibraryHtml } from './library';
import { getBugReportSpec, handleBugReportSubmit } from './bug-reports';
import type { BugReportEnv } from './bug-reports';
import {
  generateSlug,
  getPresentedSecret,
  getPublicBaseUrl,
  hashSecret,
  isPlainObject,
  isShareRole,
  stripEphemeralCollabSpans,
  timingSafeEqualStrings,
} from './util';
import type { ResolvedRole, ShareRole } from './util';

export interface ApiEnv extends BugReportEnv {
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
  PROOF_DEFAULT_HUMAN_ROLE?: string;
  SNAPSHOTS?: R2Bucket;
  PROOF_SNAPSHOT_PREFIX?: string;
}

/** Absolute snapshot URL when the R2 binding is configured, else null. */
function buildSnapshotUrl(request: Request, env: ApiEnv, slug: string): string | null {
  if (!env.SNAPSHOTS) return null;
  const base = getPublicBaseUrl(request, env);
  const path = snapshotPublicPath(slug);
  return base ? `${base}${path}` : path;
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
    snapshotUrl: buildSnapshotUrl(request, env, slug),
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

async function authorizeDirectShare(request: Request, env: ApiEnv): Promise<Response | null> {
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
    if (presented && (await timingSafeEqualStrings(presented, apiKey))) return null;
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
  const denied = await authorizeDirectShare(request, env);
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

/**
 * Instance-wide default role for tokenless SSO humans (see the access-authn
 * ADR): Access already authenticated them, so a clean /d/:slug link grants
 * this role on ACTIVE documents. Agents never get a default role — their
 * access stays document-token-gated (unchanged contract behavior).
 */
function resolveDefaultHumanRole(env: ApiEnv): ShareRole {
  const value = env.PROOF_DEFAULT_HUMAN_ROLE?.trim();
  return isShareRole(value) ? value : 'editor';
}

async function handleCollabSession(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
): Promise<Response> {
  const { state, role: tokenRole } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (state.shareState !== 'ACTIVE' && tokenRole !== 'owner_bot') {
    // Runs before the default-role grant: paused/revoked documents block
    // tokenless humans too.
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  const role =
    tokenRole ??
    (identity.kind === 'human' ? resolveDefaultHumanRole(env) : null);
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
  const payload = await buildCollabSessionPayload(request, env, state, role, identity);
  if (payload instanceof Response) return payload;
  return json({ success: true, ...payload });
}

function capabilitiesForRole(role: ResolvedRole): {
  canRead: boolean;
  canComment: boolean;
  canEdit: boolean;
} {
  return {
    canRead: true,
    canComment: role === 'commenter' || role === 'editor' || role === 'owner_bot',
    canEdit: role === 'editor' || role === 'owner_bot',
  };
}

/**
 * Session + capabilities in the exact shape the web client validates
 * (ShareClient.isCollabSessionInfo): missing fields make the browser
 * silently degrade to no-collab mode.
 */
async function buildCollabSessionPayload(
  request: Request,
  env: ApiEnv,
  state: NonNullable<Awaited<ReturnType<DocumentDO['getState']>>>,
  role: ResolvedRole,
  identity: Identity,
): Promise<
  | { session: Record<string, unknown>; capabilities: ReturnType<typeof capabilitiesForRole> }
  | Response
> {
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
    slug: state.slug,
    role: collabRole,
    sub,
    exp,
    epoch: state.accessEpoch,
  });
  const base = getPublicBaseUrl(request, env);
  const wsBase = base.replace(/^http/, 'ws');
  return {
    session: {
      docId: state.docId,
      slug: state.slug,
      role: collabRole,
      shareState: state.shareState,
      accessEpoch: state.accessEpoch,
      syncProtocol: 'pm-yjs-v1',
      collabWsUrl: `${wsBase}/documents/${state.slug}/collab`,
      token,
      snapshotVersion: state.revision,
      expiresAt: new Date(exp * 1000).toISOString(),
      ttlSeconds: ttl,
      // Verified identity, threaded to the client so presence and
      // provenance attribute to the real actor (issue #9).
      sub,
      identity:
        identity.kind === 'human'
          ? { kind: 'human', email: identity.email }
          : { kind: 'agent', serviceTokenId: identity.serviceTokenId },
    },
    capabilities: capabilitiesForRole(role),
  };
}

/**
 * Combined boot endpoint for the web editor's /d/:slug flow: document,
 * collab session, and capabilities in one round trip (the client's
 * ShareClient.fetchOpenContext is the primary boot path).
 */
async function handleOpenContext(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { state, role: tokenRole } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (state.shareState === 'DELETED') {
    return json({ success: false, error: 'Document deleted' }, 410);
  }
  if (state.shareState !== 'ACTIVE' && tokenRole !== 'owner_bot') {
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  const role =
    tokenRole ??
    (identity.kind === 'human' ? resolveDefaultHumanRole(env) : null);
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

  // Library visit tracking (issue #15): write-behind so the open path
  // never blocks on D1.
  if (identity.kind === 'human' && ctx) {
    ctx.waitUntil(recordVisit(env.DB, identity.email, slug, role));
  }

  const base = getPublicBaseUrl(request, env);
  const doc = {
    slug: state.slug,
    docId: state.docId,
    title: state.title,
    markdown: state.markdown,
    marks: JSON.parse(state.marksJson),
    active: state.shareState === 'ACTIVE',
    shareState: state.shareState,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    viewers: 0,
  };
  const payload = await buildCollabSessionPayload(request, env, state, role, identity);
  const collab =
    payload instanceof Response
      ? { collabAvailable: false as const }
      : payload;
  return json({
    success: true,
    doc,
    ...('session' in collab
      ? { session: collab.session, capabilities: collab.capabilities }
      : { collabAvailable: false, capabilities: capabilitiesForRole(role) }),
    links: {
      webUrl: base ? `${base}/d/${state.slug}` : `/d/${state.slug}`,
      snapshotUrl: buildSnapshotUrl(request, env, state.slug),
    },
    mutationBase: null,
    snapshotUrl: buildSnapshotUrl(request, env, state.slug),
  });
}

// ---------------------------------------------------------------------------
// Share lifecycle (issue #13)
// ---------------------------------------------------------------------------

type LifecycleVerb = 'pause' | 'resume' | 'revoke' | 'delete';

const LIFECYCLE_TARGET_STATE: Record<
  LifecycleVerb,
  'ACTIVE' | 'PAUSED' | 'REVOKED' | 'DELETED'
> = {
  pause: 'PAUSED',
  resume: 'ACTIVE',
  revoke: 'REVOKED',
  delete: 'DELETED',
};

/** Owner operations require the ownerSecret (upstream canOwnerMutate). */
async function handleLifecycle(
  request: Request,
  env: ApiEnv,
  slug: string,
  verb: LifecycleVerb,
  identity: Identity,
): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (role !== 'owner_bot') {
    return json({ error: `Not authorized to ${verb} document` }, 403);
  }
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const actor =
    identity.kind === 'agent' ? `agent:${identity.serviceTokenId}` : 'owner';
  const result = await stub.setShareState(LIFECYCLE_TARGET_STATE[verb], actor);
  if (!result) return json({ success: false, error: 'Document not found' }, 404);
  return json({
    success: true,
    shareState: result.shareState,
    snapshotUrl:
      result.shareState === 'ACTIVE' ? buildSnapshotUrl(request, env, slug) : null,
  });
}

/**
 * GET /snapshots/:slug.html — serve the read-only artifact from R2, behind
 * the edge identity gate. Access to the snapshot follows the document's
 * share state (paused/revoked stop serving for non-owners); no document
 * token is required for ACTIVE docs, matching the lenient document read.
 */
async function handleSnapshotRead(
  request: Request,
  env: ApiEnv,
  slug: string,
): Promise<Response> {
  if (!env.SNAPSHOTS) {
    return json({ success: false, error: 'Snapshots are not configured' }, 404);
  }
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  if (state.shareState === 'DELETED') {
    return json({ success: false, error: 'Document deleted' }, 410);
  }
  if (state.shareState !== 'ACTIVE' && role !== 'owner_bot') {
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  const key = snapshotObjectKey(slug, env.PROOF_SNAPSHOT_PREFIX);
  const object = await env.SNAPSHOTS.get(key);
  const html = object
    ? await object.text()
    : renderSnapshotHtml({
        title: state.title,
        markdown: state.markdown,
        slug: state.slug,
        updatedAt: state.updatedAt,
      });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, max-age=60',
    },
  });
}

/** POST /documents/:slug/access-links — mint an above-default token. */
async function handleCreateAccessLink(
  request: Request,
  env: ApiEnv,
  slug: string,
): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ error: 'Document not found' }, 404);
  if (state.shareState === 'DELETED') {
    return json({ error: 'Document deleted' }, 410);
  }
  if (role !== 'owner_bot' && role !== 'editor') {
    return json({ error: 'Not authorized to create access links' }, 403);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (isPlainObject(parsed)) body = parsed;
  } catch {
    // validated below
  }
  const requestedRole = body.role;
  if (!isShareRole(requestedRole)) {
    return json({ error: 'role must be viewer, commenter, or editor' }, 400);
  }
  const tokenId = crypto.randomUUID();
  const secret = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const created = await stub.addAccessToken(
    tokenId,
    requestedRole,
    await hashSecret(secret),
    createdAt,
  );
  if (!created.ok) return json({ error: 'Document not found' }, 404);
  const base = getPublicBaseUrl(request, env);
  const shareUrl = base ? `${base}/d/${slug}` : `/d/${slug}`;
  const separator = shareUrl.includes('?') ? '&' : '?';
  return json({
    success: true,
    slug,
    role: requestedRole,
    tokenId,
    accessToken: secret,
    token: secret,
    webShareUrl: `${shareUrl}${separator}token=${encodeURIComponent(secret)}`,
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// Agent events (issue #12)
// ---------------------------------------------------------------------------

function gateEventsAccess(
  state: NonNullable<Awaited<ReturnType<DocumentDO['getState']>>>,
  role: string | null,
): Response | null {
  if (state.shareState === 'DELETED') {
    return json({ success: false, error: 'Document deleted' }, 410);
  }
  if (state.shareState !== 'ACTIVE' && role !== 'owner_bot') {
    return json(
      { success: false, error: 'Document is not currently accessible' },
      403,
    );
  }
  if (!role) {
    return json(
      { success: false, error: 'Missing or invalid share token', code: 'UNAUTHORIZED' },
      401,
    );
  }
  return null;
}

async function handleEventsPending(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
): Promise<Response> {
  const { state, role: tokenRole } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  // Tokenless SSO humans get the instance default role here too, matching
  // open-context/collab-session (issue #9) — otherwise every clean /d/:slug
  // session polls this endpoint and 401s forever since it never holds a
  // document token to present.
  const role =
    tokenRole ??
    (identity.kind === 'human' ? resolveDefaultHumanRole(env) : null);
  const denied = gateEventsAccess(state, role);
  if (denied) return denied;
  const url = new URL(request.url);
  const after = Number(url.searchParams.get('after') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const { events, cursor } = await stub.listEvents(after, limit);
  return json({ success: true, events, cursor });
}

async function handleEventsAck(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
): Promise<Response> {
  const { state, role } = await loadDocAndRole(request, env, slug);
  if (!state) return json({ success: false, error: 'Document not found' }, 404);
  const denied = gateEventsAccess(state, role);
  if (denied) return denied;
  if (role !== 'editor' && role !== 'owner_bot') {
    return json({ success: false, error: 'Insufficient role for operation' }, 403);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (isPlainObject(parsed)) body = parsed;
  } catch {
    // fall through to validation
  }
  const upToId = Number(body.upToId);
  if (!Number.isInteger(upToId) || upToId < 0) {
    return json({ success: false, error: 'upToId must be a non-negative integer' }, 400);
  }
  const by =
    typeof body.by === 'string' && body.by.trim()
      ? body.by.trim()
      : identity.kind === 'agent'
        ? `agent:${identity.serviceTokenId}`
        : 'owner';
  const stub = env.DOCUMENT_DO.get(env.DOCUMENT_DO.idFromName(slug));
  const acked = await stub.ackEvents(upToId, by);
  return json({ success: true, acked });
}

// ---------------------------------------------------------------------------
// Agent ops (issue #10)
// ---------------------------------------------------------------------------

/**
 * Ops execute inside the document DO (single serialized writer). The Worker
 * verifies edge identity, pre-hashes the presented document token, and
 * forwards through partyserver fetch so the DO is fully initialized (live
 * Y.Doc) when the op runs. The internal headers cannot be forged from
 * outside: this is the only path that reaches the DO's onRequest.
 */
async function forwardToDocumentDo(
  request: Request,
  env: ApiEnv,
  slug: string,
  identity: Identity,
  internalPath: string,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  const presented = getPresentedSecret(request);
  if (presented) headers.set('x-proof-secret-hash', await hashSecret(presented));
  const idempotencyKey =
    request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key');
  if (idempotencyKey) headers.set('x-proof-idempotency-key', idempotencyKey);
  headers.set('x-proof-actor', JSON.stringify(identity));
  const clientIp =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '';
  if (clientIp) headers.set('x-proof-client-ip', clientIp);
  const stub = await getServerByName(
    env.DOCUMENT_DO as unknown as Parameters<typeof getServerByName>[0],
    slug,
  );
  return stub.fetch(
    new Request(`https://document-do${internalPath}`, {
      method: request.method === 'PUT' ? 'PUT' : 'POST',
      headers,
      body: await request.text(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Returns null when the path is not an API route (falls through to assets). */
export async function handleApiRequest(
  request: Request,
  env: ApiEnv,
  _identity: Identity,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Personal library (issue #15): humans only, keyed by SSO email.
  if (method === 'GET' && (path === '/library' || path === '/api/library')) {
    if (_identity.kind !== 'human') {
      return json(
        { success: false, error: 'The library is per-human SSO identity' },
        403,
      );
    }
    const rows = await queryLibrary(env.DB, _identity.email);
    if (path === '/api/library') {
      return json({ success: true, user: _identity.email, documents: rows });
    }
    return new Response(renderLibraryHtml(_identity.email, rows), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

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

  const opsMatch =
    path.match(/^\/(?:api\/)?documents\/([a-z0-9-]+)\/ops$/) ??
    path.match(/^\/api\/agent\/([a-z0-9-]+)\/ops$/);
  if (method === 'POST' && opsMatch) {
    return forwardToDocumentDo(request, env, opsMatch[1], _identity, '/internal/ops');
  }

  // Bug-report bridge (issue #16): plain-fetch filing to the configured
  // repo. Upstream mounted these under both /api/agent and /documents.
  const bugReportMatch = path.match(/^\/(?:api\/agent|documents)\/bug-reports$/);
  if (bugReportMatch) {
    if (method === 'GET') return json({ success: true, ...getBugReportSpec() });
    if (method === 'POST') return handleBugReportSubmit(request, env, _identity);
  }
  if (
    method === 'GET' &&
    path.match(/^\/(?:api\/agent|documents)\/bug-reports\/spec$/)
  ) {
    return json({ success: true, ...getBugReportSpec() });
  }

  const snapshotMatch = path.match(/^\/snapshots\/([a-z0-9-]+)\.html$/);
  if (method === 'GET' && snapshotMatch) {
    return handleSnapshotRead(request, env, snapshotMatch[1]);
  }

  const lifecycleMatch = path.match(
    /^\/(?:api\/)?documents\/([a-z0-9-]+)\/(pause|resume|revoke|delete)$/,
  );
  if (method === 'POST' && lifecycleMatch) {
    return handleLifecycle(
      request,
      env,
      lifecycleMatch[1],
      lifecycleMatch[2] as LifecycleVerb,
      _identity,
    );
  }

  const accessLinkMatch = path.match(
    /^\/(?:api\/)?documents\/([a-z0-9-]+)\/access-links$/,
  );
  if (method === 'POST' && accessLinkMatch) {
    return handleCreateAccessLink(request, env, accessLinkMatch[1]);
  }

  const eventsMatch =
    path.match(/^\/(?:api\/)?documents\/([a-z0-9-]+)\/events\/(pending|ack)$/) ??
    path.match(/^\/api\/agent\/([a-z0-9-]+)\/events\/(pending|ack)$/);
  if (eventsMatch) {
    if (method === 'GET' && eventsMatch[2] === 'pending') {
      return handleEventsPending(request, env, eventsMatch[1], _identity);
    }
    if (method === 'POST' && eventsMatch[2] === 'ack') {
      return handleEventsAck(request, env, eventsMatch[1], _identity);
    }
  }

  const titleMatch = path.match(/^\/(?:api\/)?documents\/([a-z0-9-]+)\/title$/);
  if (method === 'PUT' && titleMatch) {
    return forwardToDocumentDo(request, env, titleMatch[1], _identity, '/internal/title');
  }

  const openContextMatch = path.match(
    /^\/(?:api\/)?documents\/([a-z0-9-]+)\/open-context$/,
  );
  if (method === 'GET' && openContextMatch) {
    return handleOpenContext(request, env, openContextMatch[1], _identity, ctx);
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
  if (method === 'PUT' && docMatch) {
    return forwardToDocumentDo(request, env, docMatch[1], _identity, '/internal/document');
  }
  if (method === 'DELETE' && docMatch) {
    return handleLifecycle(request, env, docMatch[1], 'delete', _identity);
  }

  return null;
}
