/**
 * DocumentDO — one Durable Object per document slug.
 *
 * The single serialized writer for a document (see the workers-do-per-document
 * ADR). Owns canonical content + access tokens in DO SQLite and, via
 * y-partyserver's YServer, the live Yjs collaboration room (WebSocket
 * hibernation, sync + awareness). Connections authenticate with HMAC collab
 * session tokens minted by the Worker (see collab-token.ts); viewer-role
 * connections are read-only.
 *
 * Durability (issue #8): canonical document state is the Yjs CRDT, persisted
 * as an incremental update log + periodic full snapshots in DO SQLite.
 *   - Every Y.Doc update is written to `yjs_update` synchronously as it
 *     arrives, so no acknowledged edit is ever lost to eviction/hibernation.
 *   - The projection (markdown, marks JSON, plain text) is derived on a
 *     debounced cadence (YServer onSave) with a DO Alarm as a durable
 *     backstop, bumping the revision and refreshing the D1 index row.
 *   - Once `PROOF_YJS_SNAPSHOT_EVERY_UPDATES` updates accumulate past the
 *     last snapshot, the full doc state is snapshotted and the covered
 *     update rows are deleted (compaction).
 *   - Cold start / post-hibernation load replays snapshot + updates, so
 *     reconnecting clients keep CRDT identity (no duplicated content).
 *     Markdown parsing is only the one-time hydration path for documents
 *     created via the HTTP API before any collab session existed.
 *
 * Because this DO is the single serialized writer, upstream's breaker/
 * quarantine/repair machinery is intentionally NOT ported; divergence between
 * canonical state and projection is structurally impossible, and
 * getProjectionHealth() asserts it by replaying the durable state.
 */

import { Doc as YDoc, applyUpdate, encodeStateAsUpdate } from 'yjs';
import { yXmlFragmentToProseMirrorRootNode, prosemirrorToYXmlFragment } from 'y-prosemirror';
import { YServer } from 'y-partyserver';
import type { Connection, ConnectionContext } from 'partyserver';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
} from './headless-engine.js';
import { resolveCollabSigningSecret, verifyCollabToken } from './collab-token';
import { hashSecret } from './util';
import type { ResolvedRole } from './util';
import { canonicalizeStoredMarks } from '../src/formats/marks';
import type { CommentReply, StoredMark } from '../src/formats/marks';
import {
  authorizeDocumentOp,
  buildImplicitLegacyTarget,
  parseDocumentOp,
  parseOpAddressing,
  resolveOpAnchor,
  stripAuthoredMarks,
  validateRewritePayload,
} from './ops';
import type { DocumentOpType, OpStoredMark } from './ops';
import {
  buildAcceptedSuggestionMarkdownFromSelection,
  buildStoredSelectionMetadata,
} from './visible-text';
import { renderSnapshotHtml, snapshotObjectKey } from './snapshot';

export interface CreateDocumentInput {
  slug: string;
  docId: string;
  title: string | null;
  markdown: string;
  marksJson: string;
  ownerId: string | null;
  ownerSecretHash: string;
  accessTokenId: string;
  accessSecretHash: string;
  accessRole: 'viewer' | 'commenter' | 'editor';
  createdAt: string;
}

export interface DocumentMeta {
  slug: string;
  docId: string;
  title: string | null;
  shareState: string;
  accessEpoch: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentState extends DocumentMeta {
  markdown: string;
  marksJson: string;
  ownerId: string | null;
}

export interface ProjectionHealth {
  /** Replayed canonical state serializes to exactly the stored projection. */
  consistent: boolean;
  /** False for documents that predate durable Yjs state (markdown is canonical). */
  hasYjsState: boolean;
  /** Updates persisted but not yet reflected in the projection. */
  pendingUpdates: number;
  updateRows: number;
  snapshotSeq: number;
  projectedSeq: number;
  maxSeq: number;
  revision: number;
}

interface DoEnv {
  DB?: D1Database;
  PROOF_COLLAB_SIGNING_SECRET?: string;
  PROOF_DEV_MODE?: string;
  PROOF_COLLAB_PERSIST_DEBOUNCE_MS?: string;
  PROOF_YJS_SNAPSHOT_EVERY_UPDATES?: string;
  PROOF_OPS_RATE_LIMIT_MAX?: string;
  PROOF_OPS_RATE_LIMIT_WINDOW_MS?: string;
  PROOF_EVENT_RETENTION_MAX?: string;
  SNAPSHOTS?: R2Bucket;
  PROOF_SNAPSHOT_PREFIX?: string;
}

/** Projection persist debounce, mirroring upstream COLLAB_PERSIST_DEBOUNCE_MS. */
const PERSIST_DEBOUNCE_MS = 250;
/** Snapshot + compact once this many updates accumulate past the last snapshot. */
const SNAPSHOT_EVERY_UPDATES = 100;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export class DocumentDO extends YServer {
  static callbackOptions = {
    debounceWait: PERSIST_DEBOUNCE_MS,
    debounceMaxWait: 5_000,
    timeout: 10_000,
  };

  private store = this.ctx.storage.sql;
  private snapshotEvery: number;
  private persistBackstopMs: number;
  /** True once onLoad hydrated this.document (RPC calls don't run onStart). */
  private loaded = false;
  private alarmScheduled = false;
  private persisting = false;

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS document (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        slug TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT,
        markdown TEXT NOT NULL,
        marks TEXT NOT NULL DEFAULT '{}',
        plain_text TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        share_state TEXT NOT NULL DEFAULT 'ACTIVE',
        access_epoch INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT,
        owner_secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_access (
        token_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_document_access_secret
        ON document_access(secret_hash);
      CREATE TABLE IF NOT EXISTS yjs_update (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yjs_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot BLOB,
        snapshot_seq INTEGER NOT NULL DEFAULT 0,
        projected_seq INTEGER NOT NULL DEFAULT 0,
        snapshot_at TEXT
      );
      INSERT OR IGNORE INTO yjs_meta (id, snapshot_seq, projected_seq)
        VALUES (1, 0, 0);
      CREATE TABLE IF NOT EXISTS document_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL DEFAULT '{}',
        actor TEXT,
        created_at TEXT NOT NULL,
        acked_by TEXT,
        acked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency_record (
        idempotency_key TEXT NOT NULL,
        route TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (idempotency_key, route)
      );
    `);
    // DOs created before the durability slice lack plain_text.
    const cols = this.store
      .exec(`SELECT name FROM pragma_table_info('document')`)
      .toArray()
      .map((r) => String(r.name));
    if (!cols.includes('plain_text')) {
      this.store.exec('ALTER TABLE document ADD COLUMN plain_text TEXT');
    }
    // DOs created before delegated agent identity lack operator
    // (docs/adr/2026-07-delegated-agent-identity-operator-provenance.md).
    const eventCols = this.store
      .exec(`SELECT name FROM pragma_table_info('document_event')`)
      .toArray()
      .map((r) => String(r.name));
    if (!eventCols.includes('operator')) {
      this.store.exec('ALTER TABLE document_event ADD COLUMN operator TEXT');
    }

    const debounceWait = positiveInt(
      env.PROOF_COLLAB_PERSIST_DEBOUNCE_MS,
      PERSIST_DEBOUNCE_MS,
    );
    this.snapshotEvery = positiveInt(
      env.PROOF_YJS_SNAPSHOT_EVERY_UPDATES,
      SNAPSHOT_EVERY_UPDATES,
    );
    this.persistBackstopMs = Math.max(debounceWait * 4, 2_000);
    // YServer reads callbackOptions off the class in onStart, but env only
    // exists per-instance — write the configured value back to the static.
    // All instances in an isolate share one env, so the value is stable.
    (this.constructor as typeof DocumentDO).callbackOptions = {
      debounceWait,
      debounceMaxWait: Math.max(debounceWait * 20, 5_000),
      timeout: 10_000,
    };
  }

  private row(): Record<string, unknown> | null {
    const cursor = this.store.exec('SELECT * FROM document WHERE id = 1');
    const rows = cursor.toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  private metaRow(): Record<string, unknown> {
    return this.store.exec('SELECT * FROM yjs_meta WHERE id = 1').toArray()[0] as Record<
      string,
      unknown
    >;
  }

  private maxSeq(): number {
    const meta = this.metaRow();
    const rows = this.store
      .exec('SELECT MAX(seq) AS max_seq FROM yjs_update')
      .toArray();
    const maxRow = rows[0]?.max_seq;
    return Math.max(Number(meta.snapshot_seq), maxRow === null ? 0 : Number(maxRow));
  }

  private hasYjsState(): boolean {
    const meta = this.metaRow();
    if (meta.snapshot !== null && meta.snapshot !== undefined) return true;
    const rows = this.store
      .exec('SELECT COUNT(*) AS n FROM yjs_update')
      .toArray();
    return Number(rows[0]?.n) > 0;
  }

  /** Rebuild a Y.Doc from the durable log: latest snapshot + later updates. */
  private replayFromStorage(): YDoc {
    const doc = new YDoc({ gc: true });
    const meta = this.metaRow();
    if (meta.snapshot !== null && meta.snapshot !== undefined) {
      applyUpdate(doc, new Uint8Array(meta.snapshot as ArrayBuffer));
    }
    const updates = this.store
      .exec('SELECT data FROM yjs_update ORDER BY seq ASC')
      .toArray();
    for (const row of updates) {
      applyUpdate(doc, new Uint8Array(row.data as ArrayBuffer));
    }
    return doc;
  }

  // -------------------------------------------------------------------------
  // Collaboration (y-partyserver hooks)
  // -------------------------------------------------------------------------

  /** Verify the collab session token before letting the Yjs handshake begin. */
  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    const doc = this.row();
    const secret = resolveCollabSigningSecret(this.env as DoEnv);
    const token = new URL(ctx.request.url).searchParams.get('token');
    if (!doc || !secret || !token) {
      conn.close(4401, 'missing or invalid collab token');
      return;
    }
    const claims = await verifyCollabToken(secret, token, {
      slug: String(doc.slug),
      epoch: Number(doc.access_epoch),
    });
    if (!claims || String(doc.share_state) !== 'ACTIVE') {
      conn.close(4401, 'missing or invalid collab token');
      return;
    }
    conn.setState({ role: claims.role, sub: claims.sub });
    super.onConnect(conn, ctx);
  }

  override isReadOnly(connection: Connection): boolean {
    const state = connection.state as { role?: string } | null;
    return state?.role === 'viewer';
  }

  /**
   * Hydrate the Y.Doc. Canonical path: replay the persisted Yjs snapshot +
   * update log, preserving CRDT identity across cold starts and hibernation
   * wakes. Legacy path (documents created over HTTP before any collab
   * session): parse the stored markdown once, then immediately snapshot so
   * every later load replays instead of re-parsing.
   */
  override async onLoad(): Promise<void> {
    const doc = this.row();
    if (!doc) return;

    if (this.hasYjsState()) {
      const meta = this.metaRow();
      if (meta.snapshot !== null && meta.snapshot !== undefined) {
        applyUpdate(this.document, new Uint8Array(meta.snapshot as ArrayBuffer));
      }
      const updates = this.store
        .exec('SELECT data FROM yjs_update ORDER BY seq ASC')
        .toArray();
      for (const row of updates) {
        applyUpdate(this.document, new Uint8Array(row.data as ArrayBuffer));
      }
    } else {
      const hydrated = await this.hydrateFromMarkdown(doc);
      if (hydrated) {
        // Baseline snapshot: from here on, cold starts replay CRDT state.
        this.writeSnapshot(0);
      }
    }

    this.loaded = true;
    this.document.on('update', (update: Uint8Array) => {
      this.persistUpdate(update);
    });
    this.observeHumanMarkActivity();

    // Self-heal: a crash between update persistence and the debounced
    // projection write leaves projected_seq behind — catch up now.
    if (this.maxSeq() > Number(this.metaRow().projected_seq)) {
      this.persistProjection().catch((err) => {
        console.error('projection self-heal failed', err);
      });
    }
  }

  /** Returns false only when the stored markdown failed to parse. */
  private async hydrateFromMarkdown(doc: Record<string, unknown>): Promise<boolean> {
    const marksMap = this.document.getMap('marks');
    if (marksMap.size === 0) {
      try {
        const marks = JSON.parse(String(doc.marks ?? '{}')) as Record<string, unknown>;
        this.document.transact(() => {
          for (const [key, value] of Object.entries(marks)) marksMap.set(key, value);
        });
      } catch {
        // Corrupt marks JSON should not block collaboration on the text.
      }
    }
    const markdown = String(doc.markdown ?? '');
    if (!markdown.trim()) return true;
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (!parsed.doc) {
      console.error('collab hydrate: markdown parse failed', parsed.error);
      return false;
    }
    const fragment = this.document.getXmlFragment('prosemirror');
    this.document.transact(() => {
      prosemirrorToYXmlFragment(parsed.doc!, fragment);
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Durability: update log, snapshots, projection
  // -------------------------------------------------------------------------

  /**
   * Synchronous per-update persistence. Runs inside the update event, so an
   * acknowledged edit is durable before the DO could hibernate or be evicted.
   */
  private persistUpdate(update: Uint8Array): void {
    this.store.exec(
      'INSERT INTO yjs_update (data, created_at) VALUES (?, ?)',
      update,
      new Date().toISOString(),
    );
    if (!this.alarmScheduled) {
      this.alarmScheduled = true;
      void this.ctx.storage.setAlarm(Date.now() + this.persistBackstopMs);
    }
  }

  /** Snapshot the current doc state and compact the covered update rows. */
  private writeSnapshot(atSeq: number, source?: YDoc): void {
    const snapshot = encodeStateAsUpdate(source ?? this.document);
    this.store.exec(
      'UPDATE yjs_meta SET snapshot = ?, snapshot_seq = ?, snapshot_at = ? WHERE id = 1',
      snapshot,
      atSeq,
      new Date().toISOString(),
    );
    // Replaying a snapshot plus updates it already contains is idempotent in
    // Yjs, so a crash between these two writes cannot corrupt state.
    this.store.exec('DELETE FROM yjs_update WHERE seq <= ?', atSeq);
  }

  /** YServer's debounced save drives the projection during activity. */
  override async onSave(): Promise<void> {
    await this.persistProjection();
  }

  /** Durable backstop: fires even if the isolate died before onSave ran. */
  override async onAlarm(): Promise<void> {
    this.alarmScheduled = false;
    await this.persistProjection();
    this.pruneAckedEvents();
  }

  /**
   * Derive the projection (markdown, marks JSON, plain text) from canonical
   * Yjs state, bump the revision when content changed, refresh the D1 index
   * row, and snapshot + compact when the update log is long enough. Uses the
   * live doc when this instance runs the collab room, otherwise replays from
   * storage (RPC-only instances never run onStart).
   */
  private async persistProjection(): Promise<void> {
    if (this.persisting) return;
    this.persisting = true;
    try {
      const doc = this.row();
      if (!doc) return;
      const maxSeq = this.maxSeq();
      const meta = this.metaRow();
      if (maxSeq <= Number(meta.projected_seq)) return;

      const source = this.loaded ? this.document : this.replayFromStorage();
      const fragment = source.getXmlFragment('prosemirror');
      let markdown = String(doc.markdown);
      let plainText =
        doc.plain_text === null || doc.plain_text === undefined
          ? ''
          : String(doc.plain_text);
      if (fragment.length > 0) {
        const parser = await getHeadlessMilkdownParser();
        const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, parser.schema);
        markdown = await serializeMarkdown(pmDoc);
        plainText = pmDoc.textBetween(0, pmDoc.content.size, '\n');
      }
      const marksJson = JSON.stringify(source.getMap('marks').toJSON());

      const changed =
        markdown !== String(doc.markdown) || marksJson !== String(doc.marks);
      const now = new Date().toISOString();
      if (changed) {
        this.store.exec(
          `UPDATE document
             SET markdown = ?, marks = ?, plain_text = ?, revision = revision + 1,
                 updated_at = ?
           WHERE id = 1`,
          markdown,
          marksJson,
          plainText,
          now,
        );
      }
      this.store.exec(
        'UPDATE yjs_meta SET projected_seq = ? WHERE id = 1',
        maxSeq,
      );

      if (maxSeq - Number(meta.snapshot_seq) >= this.snapshotEvery) {
        this.writeSnapshot(maxSeq, source);
      }

      const db = (this.env as DoEnv).DB;
      if (changed && db) {
        try {
          await db.prepare(
            'UPDATE documents SET title = ?, revision = ?, updated_at = ? WHERE slug = ?',
          )
            .bind(
              doc.title === null ? null : String(doc.title),
              Number(doc.revision) + 1,
              now,
              String(doc.slug),
            )
            .run();
        } catch (err) {
          // The D1 index is derived data; the DO row stays authoritative.
          console.error('d1 index refresh failed', err);
        }
      }
      if (changed) {
        await this.publishSnapshot();
      }
    } finally {
      this.persisting = false;
    }
  }

  /**
   * Assert the structural invariant: replaying the durable Yjs state must
   * serialize to exactly the stored projection (once no updates are pending).
   */
  async getProjectionHealth(): Promise<ProjectionHealth | null> {
    const doc = this.row();
    if (!doc) return null;
    const meta = this.metaRow();
    const maxSeq = this.maxSeq();
    const updateRows = Number(
      this.store.exec('SELECT COUNT(*) AS n FROM yjs_update').toArray()[0]?.n,
    );
    const base = {
      hasYjsState: this.hasYjsState(),
      pendingUpdates: maxSeq - Number(meta.projected_seq),
      updateRows,
      snapshotSeq: Number(meta.snapshot_seq),
      projectedSeq: Number(meta.projected_seq),
      maxSeq,
      revision: Number(doc.revision),
    };
    if (!base.hasYjsState) {
      // Pre-durability document: the markdown row is the canonical state.
      return { ...base, consistent: true };
    }
    const replay = this.replayFromStorage();
    const fragment = replay.getXmlFragment('prosemirror');
    let markdown = '';
    if (fragment.length > 0) {
      const parser = await getHeadlessMilkdownParser();
      const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, parser.schema);
      markdown = await serializeMarkdown(pmDoc);
    }
    const marksJson = JSON.stringify(replay.getMap('marks').toJSON());
    const consistent =
      markdown === String(doc.markdown) && marksJson === String(doc.marks);
    return { ...base, consistent };
  }

  // -------------------------------------------------------------------------
  // Agent ops (issue #10): executed here, the single serialized writer.
  // Marks are written into the live Y.Doc 'marks' map, so connected editors
  // see them via normal Yjs broadcast and the durable update log persists
  // them before the projection catches up.
  // -------------------------------------------------------------------------

  private opChain: Promise<unknown> = Promise.resolve();

  /** Serialize ops: a replayed Idempotency-Key never races its original. */
  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Ops arrive via partyserver fetch so onStart/onLoad has always run. */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/internal/ops') {
      const limited = this.checkOpsRateLimit(
        request.headers.get('x-proof-client-ip') || 'unknown',
      );
      if (limited) return limited;
      return this.runSerialized(() => this.handleOpsRequest(request));
    }
    if (request.method === 'PUT' && url.pathname === '/internal/document') {
      return this.runSerialized(() => this.handlePutDocument(request));
    }
    if (request.method === 'PUT' && url.pathname === '/internal/title') {
      return this.runSerialized(() => this.handlePutTitle(request));
    }
    return Response.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  /**
   * Per-document, per-IP fixed-window limiter for mutation ops (upstream
   * server/rate-limiter.ts semantics). In-memory: this DO instance is the
   * single execution context for the document, and upstream's limiter reset
   * on process restart the same way.
   */
  private rateBuckets = new Map<string, { windowStart: number; count: number }>();

  private checkOpsRateLimit(ip: string): Response | null {
    const env = this.env as DoEnv;
    const max = positiveInt(env.PROOF_OPS_RATE_LIMIT_MAX, 120);
    const windowMs = positiveInt(env.PROOF_OPS_RATE_LIMIT_WINDOW_MS, 60_000);
    const now = Date.now();
    const bucket = this.rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.rateBuckets.set(ip, { windowStart: now, count: 1 });
      return null;
    }
    bucket.count += 1;
    if (bucket.count <= max) return null;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + windowMs - now) / 1000),
    );
    return Response.json(
      {
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retryAfterSeconds,
        limit: { maxRequests: max, windowMs },
      },
      { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
    );
  }

  private async handleOpsRequest(request: Request): Promise<Response> {
    const doc = this.row();
    if (!doc) {
      return Response.json(
        { success: false, error: 'Document not found' },
        { status: 404 },
      );
    }
    const bodyText = await request.text();
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      raw = null;
    }
    const parsed = parseDocumentOp(raw);
    if (!parsed.ok) {
      return Response.json({ success: false, error: parsed.error }, { status: 400 });
    }

    const secretHash = request.headers.get('x-proof-secret-hash') || null;
    const role = await this.resolveRole(secretHash);
    const denied = authorizeDocumentOp(parsed.op, role, String(doc.share_state));
    if (denied) {
      return Response.json(denied.body, { status: denied.status });
    }

    const idempotencyKey = request.headers.get('x-proof-idempotency-key')?.trim() || null;
    const route = `ops:${parsed.op}`;
    const requestHash = await hashSecret(bodyText);
    if (idempotencyKey) {
      const record = this.store
        .exec(
          'SELECT request_hash, status_code, response_json FROM idempotency_record WHERE idempotency_key = ? AND route = ?',
          idempotencyKey,
          route,
        )
        .toArray();
      if (record.length > 0) {
        if (String(record[0].request_hash) !== requestHash) {
          return Response.json(
            {
              success: false,
              code: 'IDEMPOTENCY_KEY_REUSED',
              error: 'Idempotency key was already used with a different request body',
            },
            { status: 409 },
          );
        }
        return Response.json(JSON.parse(String(record[0].response_json)), {
          status: Number(record[0].status_code),
        });
      }
    }

    const { actor, operator } = this.deriveOpIdentity(request);
    const result = await this.executeOp(parsed.op, parsed.payload, actor, operator);

    if (idempotencyKey && result.status >= 200 && result.status < 300) {
      this.store.exec(
        `INSERT OR REPLACE INTO idempotency_record
           (idempotency_key, route, request_hash, status_code, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        idempotencyKey,
        route,
        requestHash,
        result.status,
        JSON.stringify(result.body),
        new Date().toISOString(),
      );
    }
    return Response.json(result.body, { status: result.status });
  }

  /**
   * Map the Worker-verified identity (x-proof-actor, unforgeable from
   * outside) to an actor string plus, for delegated agents, the Operator.
   * A human identity carrying a delegatedAgentId is an Agent for
   * provenance: actor keeps the plain `ai:<agentId>` format and the
   * Operator's email rides in the additive `operator` field (ADR:
   * delegated-agent-identity-operator-provenance).
   */
  private deriveOpIdentity(request: Request): { actor: string; operator: string | null } {
    const header = request.headers.get('x-proof-actor');
    if (header) {
      try {
        const identity = JSON.parse(header) as Record<string, unknown>;
        if (identity.kind === 'human' && typeof identity.email === 'string') {
          if (typeof identity.delegatedAgentId === 'string' && identity.delegatedAgentId) {
            return { actor: `ai:${identity.delegatedAgentId}`, operator: identity.email };
          }
          return { actor: `human:${identity.email}`, operator: null };
        }
        if (identity.kind === 'agent' && typeof identity.serviceTokenId === 'string') {
          return { actor: `ai:${identity.serviceTokenId}`, operator: null };
        }
      } catch {
        // fall through to the default actor
      }
    }
    return { actor: 'ai:unknown', operator: null };
  }

  /**
   * Event emission for HUMAN collab actions (issue #12): comments,
   * replies, resolutions, and suggestion decisions made through the editor
   * arrive as changes to the live 'marks' map. Agent ops are skipped by
   * transaction origin — the ops pipeline already emits their events.
   */
  private observeHumanMarkActivity(): void {
    const marksMap = this.document.getMap('marks');
    const suggestionKinds = new Set(['insert', 'delete', 'replace']);
    marksMap.observe((event) => {
      if (event.transaction.origin === 'agent-op') return;
      for (const [markId, change] of event.changes.keys) {
        const mark = marksMap.get(markId) as OpStoredMark | undefined;
        if (!mark || typeof mark !== 'object') continue;
        const by = typeof mark.by === 'string' ? mark.by : null;
        if (change.action === 'add') {
          if (mark.kind === 'comment') {
            this.addEvent(
              'comment.added',
              { markId, by, quote: mark.quote ?? null, text: mark.text ?? null },
              by,
            );
          } else if (suggestionKinds.has(String(mark.kind))) {
            this.addEvent(
              'suggestion.added',
              { markId, by, kind: mark.kind, quote: mark.quote ?? null },
              by,
            );
          }
          continue;
        }
        if (change.action !== 'update') continue;
        const old = change.oldValue as OpStoredMark | undefined;
        if (mark.kind === 'comment') {
          const oldThread = Array.isArray(old?.thread) ? old.thread.length : 0;
          const newThread = Array.isArray(mark.thread) ? mark.thread.length : 0;
          if (newThread > oldThread) {
            const last = (mark.thread as Array<Record<string, unknown>>)[newThread - 1];
            this.addEvent(
              'comment.replied',
              { markId, by: last?.by ?? by, text: last?.text ?? null },
              typeof last?.by === 'string' ? last.by : by,
            );
          } else if (Boolean(old?.resolved) !== Boolean(mark.resolved)) {
            this.addEvent(
              mark.resolved ? 'comment.resolved' : 'comment.unresolved',
              { markId, by },
              by,
            );
          }
        } else if (
          suggestionKinds.has(String(mark.kind)) &&
          old?.status !== mark.status &&
          (mark.status === 'accepted' || mark.status === 'rejected')
        ) {
          this.addEvent(
            `suggestion.${mark.status}`,
            { markId, status: mark.status, by },
            by,
          );
        }
      }
    });
  }

  /** Agent event stream (issue #12): poll with a monotonic cursor. */
  async listEvents(
    after: number,
    limit: number,
  ): Promise<{
    events: Array<Record<string, unknown>>;
    cursor: number;
  }> {
    const a = Math.max(0, Math.trunc(Number(after) || 0));
    const l = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
    const rows = this.store
      .exec(
        'SELECT * FROM document_event WHERE id > ? ORDER BY id ASC LIMIT ?',
        a,
        l,
      )
      .toArray();
    const events = rows.map((row) => {
      let data: unknown = {};
      try {
        data = JSON.parse(String(row.event_data));
      } catch {
        // tolerate malformed rows
      }
      return {
        id: Number(row.id),
        type: String(row.event_type),
        data,
        actor: row.actor === null ? null : String(row.actor),
        // Additive: present only for delegated-agent actions (the Operator
        // whose credential admitted the agent).
        ...(row.operator ? { operator: String(row.operator) } : {}),
        createdAt: String(row.created_at),
        ackedAt: row.acked_at === null ? null : String(row.acked_at),
        ackedBy: row.acked_by === null ? null : String(row.acked_by),
      };
    });
    return {
      events,
      cursor: events.length > 0 ? Number(events[events.length - 1].id) : a,
    };
  }

  /** Ack events up to a cursor (at-least-once; advisory, upstream shape). */
  async ackEvents(upToId: number, by: string): Promise<number> {
    const cursor = this.store.exec(
      'UPDATE document_event SET acked_by = ?, acked_at = ? WHERE id <= ? AND acked_at IS NULL',
      by,
      new Date().toISOString(),
      Math.trunc(upToId),
    );
    return cursor.rowsWritten;
  }

  /** Bounded retention: prune old ACKED events past the cap (DO alarm). */
  private pruneAckedEvents(): void {
    const max = positiveInt(
      (this.env as DoEnv).PROOF_EVENT_RETENTION_MAX,
      1_000,
    );
    this.store.exec(
      `DELETE FROM document_event
        WHERE acked_at IS NOT NULL
          AND id <= (SELECT MAX(id) FROM document_event) - ?`,
      max,
    );
  }

  /** Append to the durable per-document event log; returns the event id. */
  private addEvent(
    type: string,
    data: Record<string, unknown>,
    actor: string | null,
    operator: string | null = null,
  ): number {
    this.store.exec(
      'INSERT INTO document_event (event_type, event_data, actor, operator, created_at) VALUES (?, ?, ?, ?, ?)',
      type,
      JSON.stringify(data),
      actor,
      operator,
      new Date().toISOString(),
    );
    const row = this.store.exec('SELECT last_insert_rowid() AS id').toArray()[0];
    return Number(row.id);
  }

  private marksSnapshot(): Record<string, StoredMark> {
    return canonicalizeStoredMarks(
      this.document.getMap('marks').toJSON() as Record<string, StoredMark>,
    );
  }

  private setMark(markId: string, mark: OpStoredMark): void {
    this.document.transact(() => {
      this.document.getMap('marks').set(markId, mark);
    }, 'agent-op');
  }

  /**
   * Apply new markdown to the LIVE fragment through y-prosemirror's
   * incremental updateYFragment diff. Unchanged nodes are reused and text
   * edits become minimal Yjs operations, so concurrent human edits in other
   * spans (or the same paragraph) merge through normal CRDT semantics — the
   * coordination upstream needed rewrite barriers for.
   */
  private async applyMarkdownToLiveDoc(markdown: string): Promise<boolean> {
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (!parsed.doc) return false;
    const fragment = this.document.getXmlFragment('prosemirror');
    this.document.transact(() => {
      prosemirrorToYXmlFragment(parsed.doc!, fragment);
    }, 'agent-op');
    return true;
  }

  /** Replace the marks map wholesale (used by rewrite/PUT semantics). */
  private replaceMarksMap(next: Record<string, unknown>): void {
    this.document.transact(() => {
      const map = this.document.getMap('marks');
      for (const key of [...map.keys()]) {
        if (!(key in next)) map.delete(key);
      }
      for (const [key, value] of Object.entries(next)) map.set(key, value);
    }, 'agent-op');
  }

  /** Re-resolve a stored suggestion's anchor against current markdown. */
  private resolveStoredMarkAnchor(
    mark: OpStoredMark,
    markdown: string,
  ):
    | { ok: true; selection: { sourceStart: number; sourceEnd: number } }
    | { ok: false; status: number; body: Record<string, unknown> } {
    const target =
      mark.target && typeof mark.target.anchor === 'string'
        ? mark.target
        : typeof mark.quote === 'string' && mark.quote
          ? buildImplicitLegacyTarget(mark.quote)
          : null;
    if (!target) {
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          code: 'ANCHOR_NOT_FOUND',
          error: 'Suggestion has no resolvable anchor',
        },
      };
    }
    const resolved = resolveOpAnchor(
      markdown,
      target,
      'Suggestion anchor could not be resolved in current markdown',
    );
    if (!resolved.ok) return resolved;
    return { ok: true, selection: resolved.anchor.selection };
  }

  /** Standard mutation success body (mirrors upstream persistMarks results). */
  private async opSuccess(
    eventId: number,
    markId: string,
    extra?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.persistProjection();
    const fresh = this.row()!;
    return {
      status: 200,
      body: {
        success: true,
        eventId,
        markId,
        shareState: String(fresh.share_state),
        updatedAt: String(fresh.updated_at),
        revision: Number(fresh.revision),
        markdown: String(fresh.markdown),
        marks: this.marksSnapshot(),
        ...extra,
      },
    };
  }

  private async executeOp(
    op: DocumentOpType,
    payload: Record<string, unknown>,
    actor: string,
    operator: string | null = null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Ops resolve anchors against the current projection: catch it up first
    // so live collab edits made moments ago are addressable.
    await this.persistProjection();
    const doc = this.row()!;
    const markdown = String(doc.markdown);
    const by =
      typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : actor;
    const now = new Date().toISOString();

    switch (op) {
      case 'comment.add': {
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          return { status: 400, body: { success: false, error: 'Missing text' } };
        }
        const addressing = parseOpAddressing(payload, 'Missing quote');
        if (!addressing.ok) {
          return { status: 400, body: { success: false, error: addressing.error } };
        }
        const resolved = resolveOpAnchor(
          markdown,
          addressing.target,
          'Anchor text not found in current markdown',
        );
        if (!resolved.ok) return { status: resolved.status, body: resolved.body };
        const meta = buildStoredSelectionMetadata(
          markdown,
          resolved.anchor.selection,
          addressing.target.anchor,
        );
        const markId = crypto.randomUUID();
        const mark: OpStoredMark = {
          kind: 'comment',
          by,
          ...(operator ? { operator } : {}),
          createdAt: now,
          quote: meta.quote,
          text,
          threadId: markId,
          thread: [],
          resolved: false,
          target: resolved.anchor.stabilizedTarget,
          ...(meta.startRel ? { startRel: meta.startRel } : {}),
          ...(meta.endRel ? { endRel: meta.endRel } : {}),
        };
        this.setMark(markId, mark);
        const eventId = this.addEvent(
          'comment.added',
          { markId, by, quote: meta.quote, text },
          by,
          operator,
        );
        return this.opSuccess(eventId, markId);
      }

      case 'comment.reply': {
        const markId = typeof payload.markId === 'string' ? payload.markId : '';
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!markId) {
          return { status: 400, body: { success: false, error: 'Missing markId' } };
        }
        if (!text) {
          return { status: 400, body: { success: false, error: 'Missing text' } };
        }
        const existing = this.document.getMap('marks').get(markId) as
          | OpStoredMark
          | undefined;
        if (!existing) {
          return { status: 404, body: { success: false, error: 'Mark not found' } };
        }
        const reply: CommentReply = {
          by,
          ...(operator ? { operator } : {}),
          text,
          at: now,
        };
        const thread = Array.isArray(existing.thread) ? [...existing.thread] : [];
        thread.push(reply);
        this.setMark(markId, { ...existing, thread });
        const eventId = this.addEvent('comment.replied', { markId, by, text }, by, operator);
        return this.opSuccess(eventId, markId, {
          mark: this.document.getMap('marks').get(markId),
        });
      }

      case 'comment.resolve':
      case 'comment.unresolve': {
        const markId = typeof payload.markId === 'string' ? payload.markId : '';
        if (!markId) {
          return { status: 400, body: { success: false, error: 'Missing markId' } };
        }
        const existing = this.document.getMap('marks').get(markId) as
          | OpStoredMark
          | undefined;
        if (!existing) {
          return { status: 404, body: { success: false, error: 'Mark not found' } };
        }
        const resolvedFlag = op === 'comment.resolve';
        this.setMark(markId, { ...existing, resolved: resolvedFlag });
        const eventId = this.addEvent(
          resolvedFlag ? 'comment.resolved' : 'comment.unresolved',
          { markId, by },
          by,
          operator,
        );
        return this.opSuccess(eventId, markId);
      }

      case 'suggestion.add': {
        const kind = typeof payload.kind === 'string' ? payload.kind : '';
        if (kind !== 'insert' && kind !== 'delete' && kind !== 'replace') {
          return {
            status: 400,
            body: { success: false, error: 'Unsupported operation payload' },
          };
        }
        const status = payload.status === undefined ? 'pending' : payload.status;
        if (status !== 'pending' && status !== 'accepted') {
          return {
            status: 400,
            body: {
              success: false,
              error: 'suggestion.add only supports status "pending" or "accepted"',
            },
          };
        }
        const content = typeof payload.content === 'string' ? payload.content : '';
        if ((kind === 'insert' || kind === 'replace') && !content) {
          return { status: 400, body: { success: false, error: 'Missing content' } };
        }
        const addressing = parseOpAddressing(payload, 'Missing quote');
        if (!addressing.ok) {
          return { status: 400, body: { success: false, error: addressing.error } };
        }
        const resolved = resolveOpAnchor(
          markdown,
          addressing.target,
          'Anchor text not found in current markdown',
        );
        if (!resolved.ok) return { status: resolved.status, body: resolved.body };
        const meta = buildStoredSelectionMetadata(
          markdown,
          resolved.anchor.selection,
          addressing.target.anchor,
        );
        const markId = crypto.randomUUID();
        const mark: OpStoredMark = {
          kind,
          by,
          ...(operator ? { operator } : {}),
          createdAt: now,
          quote: meta.quote,
          status: 'pending',
          target: resolved.anchor.stabilizedTarget,
          ...(kind !== 'delete' ? { content } : {}),
          ...(meta.startRel ? { startRel: meta.startRel } : {}),
          ...(meta.endRel ? { endRel: meta.endRel } : {}),
          range: {
            from: resolved.anchor.selection.sourceStart,
            to: resolved.anchor.selection.sourceEnd,
          },
        };
        this.setMark(markId, mark);
        const eventId = this.addEvent(
          'suggestion.added',
          { markId, by, kind, quote: meta.quote },
          by,
          operator,
        );
        if (status === 'accepted') {
          const finalized = await this.finalizeSuggestion(markId, 'accepted', by, operator);
          if (finalized.status !== 200) return finalized;
          return {
            status: 200,
            body: { ...finalized.body, acceptedImmediately: true },
          };
        }
        return this.opSuccess(eventId, markId);
      }

      case 'suggestion.accept':
      case 'suggestion.reject': {
        const markId = typeof payload.markId === 'string' ? payload.markId : '';
        if (!markId) {
          return { status: 400, body: { success: false, error: 'Missing markId' } };
        }
        return this.finalizeSuggestion(
          markId,
          op === 'suggestion.accept' ? 'accepted' : 'rejected',
          by,
          operator,
        );
      }

      case 'rewrite.apply': {
        const validated = validateRewritePayload(payload);
        if (!validated.ok) return { status: validated.status, body: validated.body };
        if (validated.baseRevision !== Number(doc.revision)) {
          return {
            status: 409,
            body: {
              success: false,
              code: 'STALE_BASE',
              error: 'Document has changed since the provided base revision',
              latestRevision: Number(doc.revision),
              latestUpdatedAt: String(doc.updated_at),
              retryWithState: `/api/agent/${String(doc.slug)}/state`,
            },
          };
        }

        let nextMarkdown: string;
        const provenanceSpans: Array<{ start: number; length: number; text: string }> = [];
        if (validated.mode === 'content') {
          nextMarkdown = validated.content!;
        } else {
          nextMarkdown = markdown;
          for (const change of validated.changes!) {
            const at = nextMarkdown.indexOf(change.find);
            if (at === -1) {
              return {
                status: 409,
                body: {
                  success: false,
                  error: 'Change target not found in current markdown',
                  code: 'CHANGE_TARGET_NOT_FOUND',
                  find: change.find,
                },
              };
            }
            nextMarkdown =
              nextMarkdown.slice(0, at) + change.replace + nextMarkdown.slice(at + change.find.length);
            if (change.replace.trim()) {
              provenanceSpans.push({ start: at, length: change.replace.length, text: change.replace });
            }
          }
        }

        const applied = await this.applyMarkdownToLiveDoc(nextMarkdown);
        if (!applied) {
          return {
            status: 400,
            body: { success: false, error: 'Rewrite markdown failed to parse' },
          };
        }
        if (validated.mode === 'content') {
          // Full rewrite resets agent provenance (upstream stripAuthoredMarks);
          // the document.rewritten event records authorship of the new body.
          this.replaceMarksMap(
            stripAuthoredMarks(this.document.getMap('marks').toJSON()),
          );
        } else {
          // Partial rewrite: record agent provenance spans for changed text.
          for (const span of provenanceSpans) {
            const meta = buildStoredSelectionMetadata(
              nextMarkdown,
              { sourceStart: span.start, sourceEnd: span.start + span.length },
              span.text,
            );
            this.setMark(crypto.randomUUID(), {
              kind: 'authored',
              by,
              ...(operator ? { operator } : {}),
              createdAt: now,
              quote: meta.quote,
              ...(meta.startRel ? { startRel: meta.startRel } : {}),
              ...(meta.endRel ? { endRel: meta.endRel } : {}),
            });
          }
        }
        const eventId = this.addEvent(
          'document.rewritten',
          { by, mode: validated.mode },
          by,
          operator,
        );
        const result = await this.opSuccess(eventId, '', {
          connectedClients: [...this.getConnections()].length,
          rewriteBarrierApplied: false,
        });
        const { markId: _unused, ...body } = result.body;
        return { status: result.status, body: { ...body, content: body.markdown } };
      }

      default:
        return {
          status: 400,
          body: { success: false, error: 'Unsupported operation payload' },
        };
    }
  }

  /**
   * Shared accept/reject path. Pending suggestions are stored marks (never
   * applied text), so reject just flips status; accept splices the change
   * into the markdown and applies it to the live fragment incrementally —
   * upstream's rehydration pipeline reduced to the single-writer model.
   */
  private async finalizeSuggestion(
    markId: string,
    status: 'accepted' | 'rejected',
    by: string,
    operator: string | null = null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const map = this.document.getMap('marks');
    const existing = map.get(markId) as OpStoredMark | undefined;
    if (!existing) {
      return { status: 404, body: { success: false, error: 'Mark not found' } };
    }
    if (existing.status === status) {
      // Idempotent no-op, matching upstream updateSuggestionStatus.
      const fresh = this.row()!;
      return {
        status: 200,
        body: {
          success: true,
          markId,
          status,
          alreadyFinalized: true,
          shareState: String(fresh.share_state),
          updatedAt: String(fresh.updated_at),
          revision: Number(fresh.revision),
          markdown: String(fresh.markdown),
          marks: this.marksSnapshot(),
        },
      };
    }
    const isTextSuggestion =
      existing.kind === 'insert' || existing.kind === 'delete' || existing.kind === 'replace';
    if (status === 'accepted' && isTextSuggestion) {
      const doc = this.row()!;
      const markdown = String(doc.markdown);
      const resolved = this.resolveStoredMarkAnchor(existing, markdown);
      if (!resolved.ok) return { status: resolved.status, body: resolved.body };
      const nextMarkdown = buildAcceptedSuggestionMarkdownFromSelection(
        markdown,
        existing as never,
        resolved.selection,
      );
      const applied = await this.applyMarkdownToLiveDoc(nextMarkdown);
      if (!applied) {
        return {
          status: 400,
          body: { success: false, error: 'Accepted suggestion failed to parse' },
        };
      }
    }
    this.setMark(markId, { ...existing, status });
    const eventId = this.addEvent(
      status === 'accepted' ? 'suggestion.accepted' : 'suggestion.rejected',
      { markId, status, by },
      by,
      operator,
    );
    return this.opSuccess(eventId, markId, {
      status,
      ...(existing.content !== undefined ? { content: existing.content } : {}),
    });
  }

  /** PUT /documents/:slug — REST document update (legacy bridge clients). */
  private async handlePutDocument(request: Request): Promise<Response> {
    const gate = await this.gateWriteRequest(request);
    if (gate.denied) return gate.denied;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await request.text()) as Record<string, unknown>;
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const markdown =
      typeof body.markdown === 'string'
        ? body.markdown
        : typeof body.content === 'string'
          ? body.content
          : null;
    if (markdown === null || !markdown.trim()) {
      return Response.json(
        { success: false, error: 'markdown field is required', code: 'MISSING_MARKDOWN' },
        { status: 400 },
      );
    }
    await this.persistProjection();
    const doc = this.row()!;
    const baseRaw = body.baseRevision ?? body.expectedRevision;
    if (baseRaw !== undefined) {
      const base = Number(baseRaw);
      if (!Number.isInteger(base) || base !== Number(doc.revision)) {
        return Response.json(
          {
            success: false,
            code: 'STALE_BASE',
            error: 'Document has changed since the provided base revision',
            latestRevision: Number(doc.revision),
            latestUpdatedAt: String(doc.updated_at),
          },
          { status: 409 },
        );
      }
    }
    const applied = await this.applyMarkdownToLiveDoc(markdown);
    if (!applied) {
      return Response.json(
        { success: false, error: 'markdown failed to parse' },
        { status: 400 },
      );
    }
    if (body.marks !== undefined && typeof body.marks === 'object' && body.marks !== null && !Array.isArray(body.marks)) {
      this.replaceMarksMap(
        canonicalizeStoredMarks(body.marks as Record<string, StoredMark>) as Record<string, unknown>,
      );
    }
    const eventId = this.addEvent(
      'document.updated',
      { by: gate.actor },
      gate.actor,
      gate.operator,
    );
    const result = await this.opSuccess(eventId, '', {});
    const { markId: _unused, ...resultBody } = result.body;
    return Response.json({ ...resultBody, content: resultBody.markdown });
  }

  /** PUT /documents/:slug/title */
  private async handlePutTitle(request: Request): Promise<Response> {
    const gate = await this.gateWriteRequest(request);
    if (gate.denied) return gate.denied;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await request.text()) as Record<string, unknown>;
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const title =
      body.title === null ? null : typeof body.title === 'string' ? body.title.trim() : undefined;
    if (title === undefined) {
      return Response.json(
        { success: false, error: 'title must be a string or null' },
        { status: 400 },
      );
    }
    const now = new Date().toISOString();
    this.store.exec(
      'UPDATE document SET title = ?, updated_at = ? WHERE id = 1',
      title === '' ? null : title,
      now,
    );
    const doc = this.row()!;
    const db = (this.env as DoEnv).DB;
    if (db) {
      try {
        await db
          .prepare('UPDATE documents SET title = ?, updated_at = ? WHERE slug = ?')
          .bind(doc.title === null ? null : String(doc.title), now, String(doc.slug))
          .run();
      } catch (err) {
        console.error('d1 index refresh failed', err);
      }
    }
    this.addEvent(
      'document.title.updated',
      { title: doc.title === null ? null : String(doc.title), by: gate.actor },
      gate.actor,
      gate.operator,
    );
    return Response.json({
      success: true,
      title: doc.title === null ? null : String(doc.title),
      updatedAt: now,
    });
  }

  /** Shared auth gate for REST write routes: editor or owner required. */
  private async gateWriteRequest(
    request: Request,
  ): Promise<{ denied: Response | null; actor: string; operator: string | null }> {
    const doc = this.row();
    if (!doc) {
      return {
        denied: Response.json(
          { success: false, error: 'Document not found' },
          { status: 404 },
        ),
        actor: 'ai:unknown',
        operator: null,
      };
    }
    const role = await this.resolveRole(request.headers.get('x-proof-secret-hash'));
    const denied = authorizeDocumentOp('rewrite.apply', role, String(doc.share_state));
    return {
      denied: denied ? Response.json(denied.body, { status: denied.status }) : null,
      ...this.deriveOpIdentity(request),
    };
  }

  // -------------------------------------------------------------------------
  // HTML share snapshots in R2 (issue #14)
  // -------------------------------------------------------------------------

  /**
   * Publish the read-only HTML snapshot to R2 (best effort, ACTIVE docs
   * only). Runs on create, on every changed projection persist, and on
   * resume; pause/revoke/delete remove the object.
   */
  private async publishSnapshot(): Promise<void> {
    const env = this.env as DoEnv;
    if (!env.SNAPSHOTS) return;
    const doc = this.row();
    if (!doc || String(doc.share_state) !== 'ACTIVE') return;
    try {
      const html = renderSnapshotHtml({
        title: doc.title === null ? null : String(doc.title),
        markdown: String(doc.markdown),
        slug: String(doc.slug),
        updatedAt: String(doc.updated_at),
      });
      await env.SNAPSHOTS.put(
        snapshotObjectKey(String(doc.slug), env.PROOF_SNAPSHOT_PREFIX),
        html,
        { httpMetadata: { contentType: 'text/html; charset=utf-8' } },
      );
    } catch (err) {
      console.error('snapshot publish failed', err);
    }
  }

  private async removeSnapshot(): Promise<void> {
    const env = this.env as DoEnv;
    const doc = this.row();
    if (!env.SNAPSHOTS || !doc) return;
    try {
      await env.SNAPSHOTS.delete(
        snapshotObjectKey(String(doc.slug), env.PROOF_SNAPSHOT_PREFIX),
      );
    } catch (err) {
      console.error('snapshot delete failed', err);
    }
  }

  // -------------------------------------------------------------------------
  // Share lifecycle (issue #13)
  // -------------------------------------------------------------------------

  /**
   * Owner share-state transition. Pause/revoke/delete bump the access epoch
   * (outstanding collab session tokens carry the old epoch and are refused
   * on reconnect) and close live connections immediately; revoke/delete also
   * permanently invalidate all document access tokens.
   */
  async setShareState(
    next: 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'DELETED',
    actor: string,
  ): Promise<{ shareState: string; accessEpoch: number } | null> {
    const doc = this.row();
    if (!doc) return null;
    const now = new Date().toISOString();
    const bumpEpoch = next !== 'ACTIVE';
    this.store.exec(
      `UPDATE document
         SET share_state = ?, access_epoch = access_epoch + ?, updated_at = ?
       WHERE id = 1`,
      next,
      bumpEpoch ? 1 : 0,
      now,
    );
    if (next === 'REVOKED' || next === 'DELETED') {
      this.store.exec(
        'UPDATE document_access SET revoked_at = ? WHERE revoked_at IS NULL',
        now,
      );
    }
    if (next !== 'ACTIVE') {
      for (const conn of this.getConnections()) {
        try {
          conn.close(4401, 'document sharing changed');
        } catch {
          // already gone
        }
      }
    }
    const eventType =
      next === 'ACTIVE'
        ? 'document.resumed'
        : next === 'PAUSED'
          ? 'document.paused'
          : next === 'REVOKED'
            ? 'document.revoked'
            : 'document.deleted';
    this.addEvent(eventType, {}, actor);
    const db = (this.env as DoEnv).DB;
    if (db) {
      try {
        await db
          .prepare('UPDATE documents SET share_state = ?, updated_at = ? WHERE slug = ?')
          .bind(next, now, String(doc.slug))
          .run();
      } catch (err) {
        console.error('d1 index refresh failed', err);
      }
    }
    if (next === 'ACTIVE') {
      await this.publishSnapshot();
    } else {
      await this.removeSnapshot();
    }
    const fresh = this.row()!;
    return {
      shareState: String(fresh.share_state),
      accessEpoch: Number(fresh.access_epoch),
    };
  }

  /** Mint an above-default document access token (issue #13). */
  async addAccessToken(
    tokenId: string,
    role: 'viewer' | 'commenter' | 'editor',
    secretHash: string,
    createdAt: string,
  ): Promise<{ ok: boolean }> {
    if (!this.row()) return { ok: false };
    this.store.exec(
      `INSERT INTO document_access (token_id, role, secret_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
      tokenId,
      role,
      secretHash,
      createdAt,
    );
    return { ok: true };
  }

  /** Session facts for the Worker's collab-session route. */
  async getCollabContext(): Promise<{ shareState: string; accessEpoch: number } | null> {
    const doc = this.row();
    if (!doc) return null;
    return {
      shareState: String(doc.share_state),
      accessEpoch: Number(doc.access_epoch),
    };
  }

  /** Create the document. Fails if this DO already holds one. */
  async create(input: CreateDocumentInput): Promise<{ ok: boolean; error?: string }> {
    if (this.row()) {
      return { ok: false, error: 'exists' };
    }
    this.store.exec(
      `INSERT INTO document
         (id, slug, doc_id, title, markdown, marks, revision, share_state,
          access_epoch, owner_id, owner_secret_hash, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, 1, 'ACTIVE', 0, ?, ?, ?, ?)`,
      input.slug,
      input.docId,
      input.title,
      input.markdown,
      input.marksJson,
      input.ownerId,
      input.ownerSecretHash,
      input.createdAt,
      input.createdAt,
    );
    this.store.exec(
      `INSERT INTO document_access (token_id, role, secret_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
      input.accessTokenId,
      input.accessRole,
      input.accessSecretHash,
      input.createdAt,
    );
    await this.publishSnapshot();
    return { ok: true };
  }

  /**
   * Resolve a presented secret hash to a role, matching upstream
   * resolveDocumentAccess: owner hash -> owner_bot, else live token row.
   */
  async resolveRole(secretHash: string | null): Promise<ResolvedRole | null> {
    const doc = this.row();
    if (!doc || !secretHash) return null;
    if (doc.owner_secret_hash === secretHash) return 'owner_bot';
    const rows = this.store
      .exec(
        `SELECT role FROM document_access
         WHERE secret_hash = ? AND revoked_at IS NULL LIMIT 1`,
        secretHash,
      )
      .toArray();
    if (rows.length === 0) return null;
    const role = rows[0].role;
    return role === 'viewer' || role === 'commenter' || role === 'editor'
      ? role
      : null;
  }

  /** Full document state (caller enforces authorization). */
  async getState(): Promise<DocumentState | null> {
    const doc = this.row();
    if (!doc) return null;
    // Reads serve the projection; if a crash beat the debounced persist,
    // catch the projection up before answering.
    if (this.maxSeq() > Number(this.metaRow().projected_seq)) {
      await this.persistProjection();
    }
    const fresh = this.row()!;
    return {
      slug: String(fresh.slug),
      docId: String(fresh.doc_id),
      title: fresh.title === null ? null : String(fresh.title),
      markdown: String(fresh.markdown),
      marksJson: String(fresh.marks),
      shareState: String(fresh.share_state),
      accessEpoch: Number(fresh.access_epoch),
      revision: Number(fresh.revision),
      ownerId: fresh.owner_id === null ? null : String(fresh.owner_id),
      createdAt: String(fresh.created_at),
      updatedAt: String(fresh.updated_at),
    };
  }
}
