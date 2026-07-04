/**
 * DocumentDO — one Durable Object per document slug.
 *
 * The single serialized writer for a document (see the workers-do-per-document
 * ADR). Owns canonical content + access tokens in DO SQLite and, via
 * y-partyserver's YServer, the live Yjs collaboration room (WebSocket
 * hibernation, sync + awareness). Connections authenticate with HMAC collab
 * session tokens minted by the Worker (see collab-token.ts); viewer-role
 * connections are read-only. onLoad hydrates the Y.Doc 'prosemirror'
 * fragment from stored markdown via the headless Milkdown engine; onSave
 * (debounced) serializes it back and bumps the revision. Later slices add
 * incremental Yjs update persistence (#8), the event queue (#12), and
 * idempotency records (#10).
 */

import { yXmlFragmentToProseMirrorRootNode, prosemirrorToYXmlFragment } from 'y-prosemirror';
import { YServer } from 'y-partyserver';
import type { Connection, ConnectionContext } from 'partyserver';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
} from './headless-engine.js';
import { resolveCollabSigningSecret, verifyCollabToken } from './collab-token';
import type { ResolvedRole } from './util';

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

interface DoEnv {
  PROOF_COLLAB_SIGNING_SECRET?: string;
  PROOF_DEV_MODE?: string;
}

/** Yjs persist debounce, mirroring upstream COLLAB_PERSIST_DEBOUNCE_MS. */
const PERSIST_DEBOUNCE_MS = 250;

export class DocumentDO extends YServer {
  static callbackOptions = {
    debounceWait: PERSIST_DEBOUNCE_MS,
    debounceMaxWait: 5_000,
    timeout: 10_000,
  };

  private store = this.ctx.storage.sql;

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
    `);
  }

  private row(): Record<string, unknown> | null {
    const cursor = this.store.exec('SELECT * FROM document WHERE id = 1');
    const rows = cursor.toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
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

  /** Hydrate the Y.Doc ('prosemirror' fragment + 'marks' map) from storage. */
  override async onLoad(): Promise<void> {
    const doc = this.row();
    if (!doc) return;
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
    const fragment = this.document.getXmlFragment('prosemirror');
    if (fragment.length > 0) return; // already hydrated this lifetime
    const markdown = String(doc.markdown ?? '');
    if (!markdown.trim()) return;
    const parser = await getHeadlessMilkdownParser();
    const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
    if (!parsed.doc) {
      console.error('collab hydrate: markdown parse failed', parsed.error);
      return;
    }
    this.document.transact(() => {
      prosemirrorToYXmlFragment(parsed.doc!, fragment);
    });
  }

  /** Debounced persistence: serialize the fragment back to markdown. */
  override async onSave(): Promise<void> {
    const doc = this.row();
    if (!doc) return;
    const fragment = this.document.getXmlFragment('prosemirror');
    if (fragment.length === 0) return;
    const parser = await getHeadlessMilkdownParser();
    const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, parser.schema);
    const markdown = await serializeMarkdown(pmDoc);
    const marksJson = JSON.stringify(this.document.getMap('marks').toJSON());
    if (markdown === String(doc.markdown) && marksJson === String(doc.marks)) return;
    this.store.exec(
      `UPDATE document
         SET markdown = ?, marks = ?, revision = revision + 1, updated_at = ?
       WHERE id = 1`,
      markdown,
      marksJson,
      new Date().toISOString(),
    );
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
    return {
      slug: String(doc.slug),
      docId: String(doc.doc_id),
      title: doc.title === null ? null : String(doc.title),
      markdown: String(doc.markdown),
      marksJson: String(doc.marks),
      shareState: String(doc.share_state),
      accessEpoch: Number(doc.access_epoch),
      revision: Number(doc.revision),
      ownerId: doc.owner_id === null ? null : String(doc.owner_id),
      createdAt: String(doc.created_at),
      updatedAt: String(doc.updated_at),
    };
  }
}
