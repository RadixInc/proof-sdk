/**
 * Client-side share operations for web viewers.
 * Detects /d/:slug URL, fetches doc from server, manages WebSocket sync.
 */

import { executeBridgeCall } from './bridge-executor';
import { buildShareMutationBaseToken } from './share-mutation-base.js';

export interface ShareDocument {
  slug: string;
  docId?: string;
  title: string | null;
  markdown: string;
  marks: Record<string, unknown>;
  readAuthority?: 'authoritative' | 'persisted_recovery';
  shareState?: 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'DELETED';
  createdAt?: string;
  updatedAt?: string;
  viewers?: number;
}

export type ShareRole = 'viewer' | 'commenter' | 'editor' | 'owner_bot';
export type ShareState = 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'DELETED';
export type AccessLinkRole = 'viewer' | 'commenter' | 'editor';

/** Verified identity from the deployment's authentication layer (issue #9). */
export type CollabSessionIdentity =
  | { kind: 'human'; email: string }
  | { kind: 'agent'; serviceTokenId: string };

export interface CollabSessionInfo {
  docId: string;
  slug: string;
  role: ShareRole;
  shareState: ShareState;
  accessEpoch: number;
  syncProtocol: 'pm-yjs-v1';
  collabWsUrl: string;
  token: string;
  snapshotVersion: number;
  expiresAt?: string;
  /** Stable actor subject, e.g. the SSO email or "agent:<id>". */
  sub?: string;
  identity?: CollabSessionIdentity;
}

export interface ShareOpenContext {
  success: boolean;
  collabAvailable?: boolean;
  code?: string;
  retryAfterMs?: number | null;
  requestId?: string | null;
  snapshotUrl?: string | null;
  mutationBase?: {
    token?: string;
    source?: string;
    schemaVersion?: number;
  } | null;
  doc: ShareDocument & {
    active?: boolean;
  };
  session?: CollabSessionInfo;
  capabilities: { canRead: boolean; canComment: boolean; canEdit: boolean };
  /** Which edge-auth story the deployment has (issue #43); additive. */
  authMode?: 'access' | 'dev';
  links: { webUrl: string; snapshotUrl: string | null };
}

export interface SharePendingEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  actor: string | null;
  createdAt: string;
  ackedAt?: string | null;
  ackedBy?: string | null;
}

export interface SharePendingEventsResponse {
  success: boolean;
  events: SharePendingEvent[];
  cursor: number;
}

export type ShareRequestError = {
  error: {
    status: number;
    code: string;
    message: string;
    retryAfterMs?: number | null;
    requestId?: string | null;
  };
};

type CollabSessionPayload = {
  session: CollabSessionInfo;
  capabilities: { canRead: boolean; canComment: boolean; canEdit: boolean };
};

type CollabUnavailablePayload = {
  collabAvailable: false;
  snapshotUrl: string | null;
  code?: string;
  retryAfterMs?: number | null;
  requestId?: string | null;
};

export interface AccessLinkResponse {
  role: AccessLinkRole;
  accessToken: string;
  token: string;
  webShareUrl: string;
}

export interface ShareMarkMutationResponse {
  success: boolean;
  marks?: Record<string, unknown>;
}

type ShareMutationBase = {
  baseToken?: string;
  baseRevision?: number;
  baseUpdatedAt?: string;
};

type KeepaliveMutationBaseOptions = {
  allowLocalBaseToken?: boolean;
};

type KeepaliveMutationBaseSelection = {
  base: ShareMutationBase | null;
  reusedObservedBase: boolean;
};

export type ShareEventHandler = (message: Record<string, unknown>) => void;
export type ShareSocketState = 'connecting' | 'connected' | 'disconnected';
type ShareConnectionStateHandler = (state: ShareSocketState) => void;
export type ShareAuthInterceptionHandler = (intercepted: boolean) => void;

export class ShareClient {
  private slug: string | null = null;
  private shareToken: string | null = null;
  private everySessionToken: string | null = null;
  private apiOriginOverride: string | null = null;
  private clientId: string | null = null;
  private ws: WebSocket | null = null;
  private eventHandlers: ShareEventHandler[] = [];
  private connectionStateHandlers: ShareConnectionStateHandler[] = [];
  private authIntercepted = false;
  private authInterceptionHandlers: ShareAuthInterceptionHandler[] = [];
  private connectionState: ShareSocketState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private viewerName: string | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private clientVersion = '0.31.0';
  private clientBuild = 'web';
  private clientProtocol = '3';
  private lastObservedUpdatedAt: string | null = null;
  private lastObservedMutationBase: ShareMutationBase | null = null;
  private mutationAccessEpoch: number | null = null;
  private authMode: 'access' | 'dev' | null = null;

  constructor() {
    this.detectShareMode();
  }

  private detectShareMode(): void {
    this.lastObservedUpdatedAt = null;
    this.lastObservedMutationBase = null;
    this.mutationAccessEpoch = null;
    const proofConfig = (window as Window & {
      __PROOF_CONFIG__?: {
        shareSlug?: string;
        shareToken?: string;
        shareSessionToken?: string;
        shareServerBaseURL?: string;
        proofClientVersion?: string;
        proofClientBuild?: string;
        proofClientProtocol?: string;
      };
    }).__PROOF_CONFIG__ ?? {};

    // Accept `/d/:slug` and `/d/:slug/` (some hosts/linkers append a trailing slash).
    const path = typeof window.location.pathname === 'string'
      ? window.location.pathname.replace(/\/+$/, '')
      : '';
    const match = path.match(/^\/d\/([^/?#]+)$/);
    if (match) {
      try {
        this.slug = decodeURIComponent(match[1]);
      } catch {
        this.slug = match[1];
      }
    } else if (typeof proofConfig.shareSlug === 'string' && proofConfig.shareSlug.trim()) {
      this.slug = proofConfig.shareSlug.trim();
    } else {
      this.slug = null;
    }
    const configToken = typeof proofConfig.shareToken === 'string' && proofConfig.shareToken.trim()
      ? proofConfig.shareToken.trim()
      : '';
    const token = new URLSearchParams(window.location.search).get('token');
    if (configToken) {
      this.shareToken = configToken;
    } else if (token && token.trim()) {
      this.shareToken = token.trim();
    } else {
      this.shareToken = null;
    }

    this.everySessionToken = (typeof proofConfig.shareSessionToken === 'string' && proofConfig.shareSessionToken.trim())
      ? proofConfig.shareSessionToken.trim()
      : null;
    this.apiOriginOverride = (typeof proofConfig.shareServerBaseURL === 'string' && proofConfig.shareServerBaseURL.trim())
      ? proofConfig.shareServerBaseURL.trim().replace(/\/+$/, '')
      : null;
    this.clientVersion = (typeof proofConfig.proofClientVersion === 'string' && proofConfig.proofClientVersion.trim())
      ? proofConfig.proofClientVersion.trim()
      : '0.31.0';
    this.clientBuild = (typeof proofConfig.proofClientBuild === 'string' && proofConfig.proofClientBuild.trim())
      ? proofConfig.proofClientBuild.trim()
      : 'web';
    this.clientProtocol = (typeof proofConfig.proofClientProtocol === 'string' && proofConfig.proofClientProtocol.trim())
      ? proofConfig.proofClientProtocol.trim()
      : '3';
  }

  private rememberObservedDocument(doc: { updatedAt?: string | undefined } | null | undefined): void {
    if (typeof doc?.updatedAt === 'string' && doc.updatedAt.trim().length > 0) {
      this.lastObservedUpdatedAt = doc.updatedAt.trim();
    }
  }

  private rememberObservedMutationBase(payload: Record<string, unknown> | null | undefined): void {
    const base = this.extractMutationBase(payload ?? null);
    if (base) {
      this.lastObservedMutationBase = base;
    }
  }

  private rememberAccessEpoch(accessEpoch: unknown): void {
    if (typeof accessEpoch === 'number' && Number.isFinite(accessEpoch)) {
      this.mutationAccessEpoch = Math.max(0, Math.trunc(accessEpoch));
    }
  }

  isShareMode(): boolean {
    return this.slug !== null;
  }

  refreshRuntimeConfig(): boolean {
    this.detectShareMode();
    return this.slug !== null;
  }

  getSlug(): string | null {
    return this.slug;
  }

  /**
   * Edge-auth story reported by open-context. Null until observed; callers
   * that must not overpromise (the agent invite) should treat null as
   * 'access' — the mode every real deployment runs in.
   */
  getAuthMode(): 'access' | 'dev' | null {
    return this.authMode;
  }

  getTokenizedWebUrl(options?: { token?: string; origin?: string }): string | null {
    if (!this.slug) return null;
    const token = options?.token?.trim() || this.shareToken;
    if (!token) return null;
    const origin = options?.origin?.trim() || this.apiOriginOverride || window.location.origin;
    return `${origin}/d/${encodeURIComponent(this.slug)}?token=${encodeURIComponent(token)}`;
  }

  getClientId(): string | null {
    return this.clientId;
  }

  setViewerName(name: string): void {
    this.viewerName = name;
  }

  private getApiBase(): string {
    const origin = this.apiOriginOverride || window.location.origin;
    return `${origin}/api`;
  }

  getApiBaseUrl(): string {
    return this.getApiBase();
  }

  getShareAuthHeaders(explicitToken?: string): Record<string, string> {
    const token = explicitToken?.trim() || this.shareToken;
    const headers: Record<string, string> = {
      'X-Proof-Client-Version': this.clientVersion,
      'X-Proof-Client-Build': this.clientBuild,
      'X-Proof-Client-Protocol': this.clientProtocol,
    };
    if (token) {
      headers['x-share-token'] = token;
    }
    if (this.everySessionToken) {
      headers.Authorization = `Bearer ${this.everySessionToken}`;
    }
    return headers;
  }

  /**
   * Detect an edge-auth interception: the deployment sits behind Cloudflare
   * Access, and when a long-lived tab's SSO session expires, Access answers
   * API fetches itself — a redirect chain ending in its login page — so the
   * client sees an HTTP 200 whose body is HTML, and the Worker never sees
   * the request. Without detection those responses parse to null and every
   * mutation becomes a silent no-op (a 200 accept that resolves nothing).
   * All API routes speak JSON (or 204), so a redirected or HTML response
   * where JSON is expected can only be an auth wall.
   */
  private isAuthInterceptedResponse(response: Response): boolean {
    if (response.status === 204 || response.status === 205) return false;
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('json')) return false;
    if (response.redirected) return true;
    return contentType.includes('text/html');
  }

  private setAuthIntercepted(intercepted: boolean): void {
    if (this.authIntercepted === intercepted) return;
    this.authIntercepted = intercepted;
    for (const handler of [...this.authInterceptionHandlers]) {
      handler(intercepted);
    }
  }

  /**
   * Subscribe to auth-interception state changes (see
   * isAuthInterceptedResponse). The handler fires immediately with the
   * current state, then on every transition. The flag clears itself when a
   * later API response parses as JSON again (e.g. the user re-authenticated
   * in another tab).
   */
  onAuthInterception(handler: ShareAuthInterceptionHandler): () => void {
    this.authInterceptionHandlers.push(handler);
    handler(this.authIntercepted);
    return () => {
      this.authInterceptionHandlers = this.authInterceptionHandlers.filter((entry) => entry !== handler);
    };
  }

  /** Read a JSON API response body, routing through auth-interception detection. */
  private async readJsonPayload<T = Record<string, unknown>>(response: Response): Promise<T | null> {
    if (this.isAuthInterceptedResponse(response)) {
      this.setAuthIntercepted(true);
      return null;
    }
    const payload = await response.json().catch(() => null) as T | null;
    if (payload !== null) this.setAuthIntercepted(false);
    return payload;
  }

  private async parseRequestError(response: Response): Promise<ShareRequestError> {
    if (this.isAuthInterceptedResponse(response)) {
      this.setAuthIntercepted(true);
    }
    const requestId = this.readRequestId(response);
    const body = await response.json().catch(() => ({} as {
      error?: unknown;
      code?: unknown;
      retryAfterMs?: unknown;
    }));
    const code = typeof body.code === 'string' && body.code.trim().length > 0
      ? body.code
      : 'unknown';
    const message = typeof body.error === 'string' && body.error.trim().length > 0
      ? body.error
      : response.statusText || 'Request failed';
    const retryAfterMs = typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs)
      ? Math.max(0, Math.trunc(body.retryAfterMs))
      : null;
    return {
      error: {
        status: response.status,
        code,
        message,
        retryAfterMs,
        requestId,
      },
    };
  }

  private readRequestId(response: Response): string | null {
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('X-Request-Id');
    return requestId && requestId.trim().length > 0 ? requestId.trim() : null;
  }

  private setConnectionState(state: ShareSocketState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const handler of [...this.connectionStateHandlers]) {
      handler(state);
    }
  }

  getConnectionState(): ShareSocketState {
    return this.connectionState;
  }

  private parseShareMarkMutationResponse(payload: Record<string, unknown> | null): ShareMarkMutationResponse {
    return {
      success: payload?.success === true,
      marks: (payload?.marks && typeof payload.marks === 'object' && !Array.isArray(payload.marks))
        ? payload.marks as Record<string, unknown>
        : undefined,
    };
  }

  /**
   * suggestion.accept/reject and comment.resolve/unresolve are dispatched
   * through the ops envelope (AGENT_CONTRACT.md), same as agent mutations —
   * there is no dedicated REST route for these actions.
   */
  private async submitMarkOp(
    type: 'suggestion.accept' | 'suggestion.reject' | 'comment.resolve' | 'comment.unresolve',
    markId: string,
    by: string,
    options?: { token?: string },
  ): Promise<ShareMarkMutationResponse | ShareRequestError | null> {
    if (!this.slug) return null;
    const response = await fetch(`${this.getApiBase()}/agent/${encodeURIComponent(this.slug)}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getShareAuthHeaders(options?.token),
      },
      body: JSON.stringify({ type, payload: { markId, by } }),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload(response);
    return this.parseShareMarkMutationResponse(payload);
  }

  private extractMutationBase(payload: Record<string, unknown> | null): ShareMutationBase | null {
    const mutationBase = payload?.mutationBase;
    if (mutationBase && typeof mutationBase === 'object' && !Array.isArray(mutationBase)) {
      const token = typeof (mutationBase as { token?: unknown }).token === 'string'
        ? (mutationBase as { token: string }).token.trim()
        : '';
      if (token) {
        return { baseToken: token };
      }
    }
    const revision = Number.isInteger(payload?.revision) ? Number(payload?.revision) : null;
    if (revision !== null && revision > 0) {
      return { baseRevision: revision };
    }
    const updatedAt = typeof payload?.updatedAt === 'string' && payload.updatedAt.trim().length > 0
      ? payload.updatedAt.trim()
      : null;
    if (updatedAt) {
      return { baseUpdatedAt: updatedAt };
    }
    return null;
  }

  private isShareRole(value: unknown): value is ShareRole {
    return value === 'viewer' || value === 'commenter' || value === 'editor' || value === 'owner_bot';
  }

  private isShareState(value: unknown): value is ShareState {
    return value === 'ACTIVE' || value === 'PAUSED' || value === 'REVOKED' || value === 'DELETED';
  }

  private isCollabSessionInfo(value: unknown): value is CollabSessionInfo {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<CollabSessionInfo>;
    return typeof candidate.docId === 'string'
      && candidate.docId.length > 0
      && typeof candidate.slug === 'string'
      && candidate.slug.length > 0
      && this.isShareRole(candidate.role)
      && this.isShareState(candidate.shareState)
      && typeof candidate.accessEpoch === 'number'
      && Number.isFinite(candidate.accessEpoch)
      && candidate.syncProtocol === 'pm-yjs-v1'
      && typeof candidate.collabWsUrl === 'string'
      && candidate.collabWsUrl.length > 0
      && typeof candidate.token === 'string'
      && candidate.token.length > 0
      && typeof candidate.snapshotVersion === 'number'
      && Number.isFinite(candidate.snapshotVersion);
  }

  private postMetric(path: string, payload: Record<string, unknown>): void {
    const url = `${this.getApiBase()}/metrics/${path}`;
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
        return;
      } catch {
        // fall through to fetch
      }
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => {
      // best-effort observability
    });
  }

  /**
   * Fetch the shared document from the server
   */
  async fetchDocument(options?: { preferPersisted?: boolean }): Promise<ShareDocument | null> {
    if (!this.slug) return null;

    try {
      const documentPath = options?.preferPersisted === true
        ? `/documents/${this.slug}/recovery`
        : `/documents/${this.slug}`;
      const response = await fetch(`${this.getApiBase()}${documentPath}`, {
        headers: this.getShareAuthHeaders(),
      });
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch document: ${response.status}`);
      }
      const payload = await this.readJsonPayload<ShareDocument>(response);
      if (!payload) throw new Error('Document response was not JSON');
      if (options?.preferPersisted !== true) {
        this.rememberObservedDocument(payload);
        this.rememberObservedMutationBase(payload as Record<string, unknown>);
      }
      return payload;
    } catch (error) {
      console.error('[ShareClient] Failed to fetch document:', error);
      throw error;
    }
  }

  async updateDocumentTitle(
    title: string | null,
    options?: { token?: string },
  ): Promise<{ success: boolean; title: string | null; updatedAt?: string } | ShareRequestError | null> {
    if (!this.slug) return null;

    const response = await fetch(`${this.getApiBase()}/documents/${this.slug}/title`, {
      method: 'PUT',
      headers: {
        ...this.getShareAuthHeaders(options?.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload<{ success?: boolean; title?: string | null; updatedAt?: string }>(response);
    if (!payload) return null;
    this.rememberObservedDocument(payload);
    this.rememberObservedMutationBase(payload as Record<string, unknown>);
    return {
      success: payload.success === true,
      title: typeof payload.title === 'string' ? payload.title : null,
      updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : undefined,
    };
  }

  async fetchCollabSession(
    options?: { token?: string }
  ): Promise<CollabSessionPayload | CollabUnavailablePayload | ShareRequestError | null> {
    if (!this.slug) return null;
    const headers = this.getShareAuthHeaders(options?.token);

    const response = await fetch(`${this.getApiBase()}/documents/${this.slug}/collab-session`, { headers });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload<{
      session?: CollabSessionInfo;
      capabilities?: { canRead: boolean; canComment: boolean; canEdit: boolean };
      collabAvailable?: boolean;
      snapshotUrl?: string | null;
      code?: unknown;
      retryAfterMs?: unknown;
    }>(response);
    if (!payload) return null;
    if (payload.collabAvailable === false) {
      return {
        collabAvailable: false,
        snapshotUrl: payload.snapshotUrl ?? null,
        code: typeof payload.code === 'string' ? payload.code : undefined,
        retryAfterMs: typeof payload.retryAfterMs === 'number' && Number.isFinite(payload.retryAfterMs)
          ? Math.max(0, Math.trunc(payload.retryAfterMs))
          : null,
        requestId: this.readRequestId(response),
      };
    }
    if (!this.isCollabSessionInfo(payload.session) || !payload.capabilities) return null;
    this.rememberAccessEpoch(payload.session.accessEpoch);
    this.rememberObservedMutationBase(payload as unknown as Record<string, unknown>);
    return {
      session: payload.session,
      capabilities: payload.capabilities,
    };
  }

  async fetchOpenContext(options?: { token?: string }): Promise<ShareOpenContext | ShareRequestError | null> {
    if (!this.slug) return null;
    const headers = this.getShareAuthHeaders(options?.token);
    const response = await fetch(`${this.getApiBase()}/documents/${this.slug}/open-context`, { headers });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload<ShareOpenContext>(response);
    if (!payload?.doc || !payload?.capabilities) return null;
    if (payload.session && !this.isCollabSessionInfo(payload.session)) return null;
    payload.requestId = this.readRequestId(response);
    this.rememberObservedDocument(payload.doc);
    this.rememberAccessEpoch(payload.session?.accessEpoch);
    this.rememberObservedMutationBase(payload as unknown as Record<string, unknown>);
    if (payload.authMode === 'access' || payload.authMode === 'dev') {
      this.authMode = payload.authMode;
    }
    return payload;
  }

  async fetchPendingEvents(
    after: number,
    options?: { token?: string; limit?: number },
  ): Promise<SharePendingEventsResponse | ShareRequestError | null> {
    if (!this.slug) return null;
    const params = new URLSearchParams();
    params.set('after', String(Math.max(0, Math.trunc(after))));
    params.set('limit', String(Math.max(1, Math.min(200, Math.trunc(options?.limit ?? 100)))));
    const response = await fetch(`${this.getApiBase()}/agent/${this.slug}/events/pending?${params.toString()}`, {
      headers: this.getShareAuthHeaders(options?.token),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload<{
      success?: boolean;
      cursor?: number;
      events?: Array<{
        id?: number;
        type?: string;
        data?: Record<string, unknown>;
        actor?: string | null;
        createdAt?: string;
        ackedAt?: string | null;
        ackedBy?: string | null;
      }>;
    }>(response);
    if (!payload) return null;
    return {
      success: payload.success === true,
      cursor: typeof payload.cursor === 'number' && Number.isFinite(payload.cursor) ? payload.cursor : Math.max(0, Math.trunc(after)),
      events: Array.isArray(payload.events)
        ? payload.events
          .filter((event) => typeof event?.id === 'number' && Number.isFinite(event.id) && typeof event?.type === 'string')
          .map((event) => ({
            id: Math.trunc(event.id as number),
            type: String(event.type),
            data: event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {},
            actor: typeof event?.actor === 'string' ? event.actor : null,
            createdAt: typeof event?.createdAt === 'string' ? event.createdAt : '',
            ackedAt: typeof event?.ackedAt === 'string' ? event.ackedAt : null,
            ackedBy: typeof event?.ackedBy === 'string' ? event.ackedBy : null,
          }))
        : [],
    };
  }

  async refreshCollabSession(): Promise<CollabSessionPayload | CollabUnavailablePayload | ShareRequestError | null> {
    if (!this.slug) return null;
    const response = await fetch(`${this.getApiBase()}/documents/${this.slug}/collab-refresh`, {
      method: 'POST',
      headers: this.getShareAuthHeaders(),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload<{
      session?: CollabSessionInfo;
      capabilities?: { canRead: boolean; canComment: boolean; canEdit: boolean };
      collabAvailable?: boolean;
      snapshotUrl?: string | null;
      code?: unknown;
      retryAfterMs?: unknown;
    }>(response);
    if (!payload) return null;
    if (payload.collabAvailable === false) {
      return {
        collabAvailable: false,
        snapshotUrl: payload.snapshotUrl ?? null,
        code: typeof payload.code === 'string' ? payload.code : undefined,
        retryAfterMs: typeof payload.retryAfterMs === 'number' && Number.isFinite(payload.retryAfterMs)
          ? Math.max(0, Math.trunc(payload.retryAfterMs))
          : null,
        requestId: this.readRequestId(response),
      };
    }
    if (!this.isCollabSessionInfo(payload.session) || !payload.capabilities) return null;
    return payload as {
      session: CollabSessionInfo;
      capabilities: { canRead: boolean; canComment: boolean; canEdit: boolean };
    };
  }

  async createAccessLink(
    role: AccessLinkRole,
    options?: { token?: string }
  ): Promise<AccessLinkResponse | ShareRequestError | null> {
    if (!this.slug) return null;
    const response = await fetch(`${this.getApiBase()}/documents/${encodeURIComponent(this.slug)}/access-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getShareAuthHeaders(options?.token),
      },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload(response);
    const accessToken = (() => {
      if (!payload) return '';
      if (typeof payload.accessToken === 'string' && payload.accessToken.trim().length > 0) {
        return payload.accessToken.trim();
      }
      if (typeof payload.token === 'string' && payload.token.trim().length > 0) {
        return payload.token.trim();
      }
      return '';
    })();
    const webShareUrl = (typeof payload?.webShareUrl === 'string') ? payload.webShareUrl.trim() : '';
    if (
      !payload
      || payload.role !== role
      || accessToken.length === 0
      || webShareUrl.length === 0
    ) {
      return null;
    }
    return {
      role,
      accessToken,
      token: accessToken,
      webShareUrl,
    };
  }

  async resolveComment(
    markId: string,
    by: string,
    options?: { token?: string }
  ): Promise<ShareMarkMutationResponse | ShareRequestError | null> {
    const trimmedMarkId = typeof markId === 'string' ? markId.trim() : '';
    const actor = typeof by === 'string' ? by.trim() : '';
    if (!trimmedMarkId || !actor) return null;
    return this.submitMarkOp('comment.resolve', trimmedMarkId, actor, options);
  }

  async unresolveComment(
    markId: string,
    by: string,
    options?: { token?: string }
  ): Promise<ShareMarkMutationResponse | ShareRequestError | null> {
    const trimmedMarkId = typeof markId === 'string' ? markId.trim() : '';
    const actor = typeof by === 'string' ? by.trim() : '';
    if (!trimmedMarkId || !actor) return null;
    return this.submitMarkOp('comment.unresolve', trimmedMarkId, actor, options);
  }

  async rejectSuggestion(
    markId: string,
    by: string,
    options?: { token?: string }
  ): Promise<ShareMarkMutationResponse | ShareRequestError | null> {
    const trimmedMarkId = typeof markId === 'string' ? markId.trim() : '';
    const actor = typeof by === 'string' ? by.trim() : '';
    if (!trimmedMarkId || !actor) return null;
    return this.submitMarkOp('suggestion.reject', trimmedMarkId, actor, options);
  }

  async acceptSuggestion(
    markId: string,
    by: string,
    options?: { token?: string }
  ): Promise<ShareMarkMutationResponse | ShareRequestError | null> {
    const trimmedMarkId = typeof markId === 'string' ? markId.trim() : '';
    const actor = typeof by === 'string' ? by.trim() : '';
    if (!trimmedMarkId || !actor) return null;
    return this.submitMarkOp('suggestion.accept', trimmedMarkId, actor, options);
  }

  async disconnectAgentPresence(
    agentId: string,
    options?: { token?: string },
  ): Promise<boolean | ShareRequestError> {
    if (!this.slug) return false;
    const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    if (!trimmedAgentId) return false;

    const response = await fetch(`${this.getApiBase()}/agent/${encodeURIComponent(this.slug)}/presence/disconnect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getShareAuthHeaders(options?.token),
      },
      body: JSON.stringify({ agentId: trimmedAgentId }),
    });
    if (!response.ok) return this.parseRequestError(response);
    const payload = await this.readJsonPayload(response);
    return payload?.success === true && payload?.disconnected === true;
  }

  async updateTitle(
    title: string,
    options?: { token?: string },
  ): Promise<boolean | ShareRequestError> {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    if (!trimmedTitle) return false;
    const result = await this.updateDocumentTitle(trimmedTitle, options);
    if (!result) return false;
    if ('error' in result) return result;
    return result.success === true;
  }

  private async buildKeepaliveMutationBase(
    markdown: string,
    marks: Record<string, unknown>,
    options?: KeepaliveMutationBaseOptions,
  ): Promise<KeepaliveMutationBaseSelection> {
    const allowLocalBaseToken = options?.allowLocalBaseToken !== false;
    if (allowLocalBaseToken && this.mutationAccessEpoch !== null) {
      const baseToken = await buildShareMutationBaseToken({
        markdown,
        marks,
        accessEpoch: this.mutationAccessEpoch,
      });
      if (baseToken) {
        return {
          base: { baseToken },
          reusedObservedBase: false,
        };
      }
    }
    if (this.lastObservedMutationBase?.baseToken) {
      return {
        base: { baseToken: this.lastObservedMutationBase.baseToken },
        reusedObservedBase: true,
      };
    }
    if (typeof this.lastObservedMutationBase?.baseRevision === 'number') {
      return {
        base: { baseRevision: this.lastObservedMutationBase.baseRevision },
        reusedObservedBase: true,
      };
    }
    if (typeof this.lastObservedMutationBase?.baseUpdatedAt === 'string') {
      return {
        base: { baseUpdatedAt: this.lastObservedMutationBase.baseUpdatedAt },
        reusedObservedBase: true,
      };
    }
    if (this.lastObservedUpdatedAt) {
      return {
        base: { baseUpdatedAt: this.lastObservedUpdatedAt },
        reusedObservedBase: false,
      };
    }
    return {
      base: null,
      reusedObservedBase: false,
    };
  }

  /**
   * Push marks update to server
   */
  async pushMarks(
    marks: Record<string, unknown>,
    actor: string,
    options?: { keepalive?: boolean }
  ): Promise<boolean> {
    if (!this.slug) return false;

    try {
      const response = await fetch(`${this.getApiBase()}/documents/${this.slug}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...this.getShareAuthHeaders(),
        },
        keepalive: Boolean(options?.keepalive),
        body: JSON.stringify({ marks, actor, clientId: this.clientId }),
      });
      return response.ok;
    } catch (error) {
      console.error('[ShareClient] Failed to push marks:', error);
      return false;
    }
  }

  /**
   * Push both content (with embedded marks) and marks metadata to server.
   * This ensures the native app receives the full markdown with mark spans.
   * Includes clientId so the server excludes us from the WS broadcast (echo prevention).
   */
  async pushUpdate(
    markdown: string,
    marks: Record<string, unknown>,
    actor: string,
    options?: { keepalive?: boolean; allowLocalKeepaliveBaseToken?: boolean },
  ): Promise<boolean> {
    if (!this.slug) return false;

    try {
      const keepaliveBase = options?.keepalive
        ? await this.buildKeepaliveMutationBase(markdown, marks, {
          allowLocalBaseToken: options.allowLocalKeepaliveBaseToken,
        })
        : { base: null, reusedObservedBase: false };
      const response = await fetch(`${this.getApiBase()}/documents/${this.slug}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...this.getShareAuthHeaders(),
        },
        keepalive: Boolean(options?.keepalive),
        body: JSON.stringify({ markdown, marks, actor, clientId: this.clientId, ...keepaliveBase.base }),
      });
      const payload = await this.readJsonPayload(response);
      this.rememberObservedDocument(payload);
      this.rememberObservedMutationBase(payload);
      if (response.ok && keepaliveBase.reusedObservedBase) {
        const nextBase = this.extractMutationBase(payload);
        if (!nextBase) {
          this.lastObservedMutationBase = null;
        }
      }
      // An intercepted 200 (Access login HTML) is not a successful push.
      return response.ok && payload !== null;
    } catch (error) {
      console.error('[ShareClient] Failed to push update:', error);
      return false;
    }
  }

  /**
   * Connect WebSocket for real-time sync
   */
  connectWebSocket(): void {
    if (!this.slug) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.setConnectionState('connected');
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.setConnectionState('connecting');
      return;
    }
    const wsToken = this.shareToken?.trim() || '';
    if (!wsToken) {
      this.setConnectionState('disconnected');
      console.warn('[ShareClient] Skipping WebSocket connection because no share token is available.');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?slug=${encodeURIComponent(this.slug)}&token=${encodeURIComponent(wsToken)}`;

    const socket = new WebSocket(wsUrl);
    this.ws = socket;
    this.setConnectionState('connecting');

    socket.onopen = () => {
      if (this.ws !== socket) return;
      console.log('[ShareClient] WebSocket connected');
      this.reconnectDelay = 1000;
      this.setConnectionState('connected');
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'connected') {
          this.clientId = message.clientId;
          console.log('[ShareClient] Assigned clientId:', this.clientId);
          // Identify ourselves to the server and advertise bridge capability.
          this.send({
            type: 'viewer.identify',
            name: this.viewerName ?? 'Anonymous',
            capabilities: { bridge: true },
          });
          return;
        }

        if (message.type === 'bridge.request') {
          void this.handleBridgeRequest(message);
          return;
        }

        // Ignore our own messages (echo prevention)
        if (message.sourceClientId === this.clientId) return;

        for (const handler of this.eventHandlers) {
          handler(message);
        }
      } catch {
        // ignore malformed messages
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      console.log('[ShareClient] WebSocket disconnected');
      this.setConnectionState('disconnected');
      this.scheduleReconnect();
    };

    socket.onerror = (error) => {
      if (this.ws !== socket) return;
      console.error('[ShareClient] WebSocket error:', error);
    };
  }

  private async handleBridgeRequest(message: Record<string, unknown>): Promise<void> {
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    const method = typeof message.method === 'string' ? message.method : null;
    const path = typeof message.path === 'string' ? message.path : null;
    const body = (typeof message.body === 'object' && message.body !== null && !Array.isArray(message.body))
      ? message.body as Record<string, unknown>
      : {};

    if (!requestId || !method || !path) {
      return;
    }

    try {
      const result = await executeBridgeCall(method, path, body);
      this.send({
        type: 'bridge.response',
        requestId,
        ok: true,
        result,
      });
    } catch (error) {
      const errorDetails = (typeof error === 'object' && error !== null && !Array.isArray(error))
        ? error as Record<string, unknown>
        : {};
      const messageText = error instanceof Error ? error.message : String(error);
      this.send({
        type: 'bridge.response',
        requestId,
        ok: false,
        error: {
          code: typeof errorDetails.code === 'string' ? errorDetails.code : 'EXECUTION_ERROR',
          message: messageText || 'Bridge execution failed',
          status: typeof errorDetails.status === 'number' ? errorDetails.status : 400,
          hint: errorDetails.hint,
          hints: errorDetails.hints,
          nextSteps: errorDetails.nextSteps,
          retryable: errorDetails.retryable,
        },
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      console.log('[ShareClient] Attempting reconnect...');
      this.connectWebSocket();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /**
   * Send a message through WebSocket
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[ShareClient] WebSocket not connected, cannot send');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Register handler for incoming WebSocket messages
   */
  onMessage(handler: ShareEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((entry) => entry !== handler);
    };
  }

  onConnectionStateChange(handler: ShareConnectionStateHandler): () => void {
    this.connectionStateHandlers.push(handler);
    handler(this.connectionState);
    return () => {
      this.connectionStateHandlers = this.connectionStateHandlers.filter((entry) => entry !== handler);
    };
  }

  reportCollabReconnect(durationMs: number, source: string = 'web'): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.postMetric('collab-reconnect', {
      durationMs,
      source,
    });
  }

  reportMarkAnchorResolution(result: 'success' | 'failure', source: string = 'web'): void {
    this.postMetric('mark-anchor', {
      result,
      source,
    });
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.onclose = null; // prevent reconnect
      socket.close();
    }
    this.setConnectionState('disconnected');
  }
}

// Export singleton
export const shareClient = new ShareClient();
