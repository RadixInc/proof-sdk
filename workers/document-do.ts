/**
 * DocumentDO — one Durable Object per document slug.
 *
 * The single serialized writer for a document (see the workers-do-per-document
 * ADR). This slice owns canonical content + access tokens in DO SQLite;
 * later slices add the Yjs collab room, event queue, and idempotency records.
 */

import { DurableObject } from 'cloudflare:workers';
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

export class DocumentDO extends DurableObject {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql.exec(`
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
    const cursor = this.sql.exec('SELECT * FROM document WHERE id = 1');
    const rows = cursor.toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  /** Create the document. Fails if this DO already holds one. */
  async create(input: CreateDocumentInput): Promise<{ ok: boolean; error?: string }> {
    if (this.row()) {
      return { ok: false, error: 'exists' };
    }
    this.sql.exec(
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
    this.sql.exec(
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
    const rows = this.sql
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
