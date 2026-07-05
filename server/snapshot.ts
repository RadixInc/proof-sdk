import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDocumentBySlug } from './db.js';
import { getCanonicalReadableDocumentSync } from './collab.js';
import { recordSnapshotPublish } from './metrics.js';
import { buildSharePreviewModel, renderSharePreviewHtmlPage, resolvePublicOrigin } from './share-preview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const snapshotDir = process.env.SNAPSHOT_DIR || path.join(__dirname, '..', 'snapshots');
const snapshotPublicBase = process.env.SNAPSHOT_PUBLIC_BASE_URL?.trim() || null;
const snapshotPublicTemplate = process.env.SNAPSHOT_PUBLIC_URL_TEMPLATE?.trim() || null;

// Object-store upload removed: snapshots are published to R2 by the Workers
// runtime (workers/snapshot.ts). This legacy module keeps only the local-disk
// path until the fork-finalization slice deletes server/ entirely.

function ensureSnapshotDir(): void {
  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }
}

function getSnapshotPreviewOrigin(): string {
  // Snapshot HTML should reference app-owned share/OG endpoints.
  // Object storage origins may host only the HTML blob and not /og/share/*.
  return resolvePublicOrigin(null);
}

function snapshotPath(slug: string): string {
  const resolvedDir = path.resolve(snapshotDir);
  const resolvedPath = path.resolve(resolvedDir, `${slug}.html`);
  const withinDir = resolvedPath === resolvedDir || resolvedPath.startsWith(`${resolvedDir}${path.sep}`);
  if (!withinDir) {
    throw new Error('Invalid snapshot slug path');
  }
  return resolvedPath;
}

function renderSnapshotHtml(input: {
  slug: string;
  title: string;
  markdown: string;
  updatedAt: string;
  shareState: string;
  revision: number | string;
}): string {
  const preview = buildSharePreviewModel({
    slug: input.slug,
    origin: getSnapshotPreviewOrigin(),
    doc: {
      title: input.title,
      markdown: input.markdown,
      updatedAt: input.updatedAt,
      shareState: input.shareState,
      revision: input.revision,
    },
  });
  return renderSharePreviewHtmlPage(preview, {
    note: 'Read-only snapshot. Live collaboration is currently unavailable.',
    markdown: input.markdown,
  });
}

function renderUnavailableSnapshotHtml(input: {
  slug: string;
  title: string;
  updatedAt: string;
  shareState: string;
  revision: number | string;
}): string {
  const preview = buildSharePreviewModel({
    slug: input.slug,
    origin: getSnapshotPreviewOrigin(),
    doc: {
      title: input.title,
      updatedAt: input.updatedAt,
      shareState: input.shareState,
      revision: input.revision,
    },
  });
  return renderSharePreviewHtmlPage(preview);
}

export function refreshSnapshotForSlug(slug: string): boolean {
  const doc = getCanonicalReadableDocumentSync(slug, 'snapshot') ?? getDocumentBySlug(slug);
  if (!doc) return false;
  ensureSnapshotDir();
  const html = doc.share_state === 'ACTIVE'
    ? renderSnapshotHtml({
        slug: doc.slug,
        title: doc.title || `Shared Document ${doc.slug}`,
        markdown: doc.markdown,
        updatedAt: doc.updated_at,
        shareState: doc.share_state,
        revision: doc.revision,
      })
    : renderUnavailableSnapshotHtml({
        slug: doc.slug,
        title: doc.title || `Shared Document ${doc.slug}`,
        updatedAt: doc.updated_at,
        shareState: doc.share_state,
        revision: doc.revision,
      });
  try {
    writeFileSync(snapshotPath(slug), html, 'utf8');
  } catch (error) {
    console.error('[snapshot] Failed to write local snapshot:', error);
    return false;
  }
  recordSnapshotPublish('success', 'local');
  return true;
}

export function getSnapshotHtml(slug: string): string | null {
  try {
    const file = snapshotPath(slug);
    if (!existsSync(file)) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function getSnapshotPublicUrl(slug: string): string | null {
  if (snapshotPublicTemplate && snapshotPublicTemplate.includes('{slug}')) {
    return snapshotPublicTemplate.replace('{slug}', encodeURIComponent(slug));
  }
  if (snapshotPublicBase) {
    return `${snapshotPublicBase.replace(/\/$/, '')}/${encodeURIComponent(slug)}.html`;
  }
  return null;
}
