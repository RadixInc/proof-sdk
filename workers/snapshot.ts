/**
 * Read-only HTML share snapshots (issue #14), re-homed to R2.
 *
 * Fidelity matches upstream's snapshot artifact (server/share-preview.ts):
 * a self-contained styled page with the title and the escaped markdown
 * snapshot. OG/social card rendering is deleted by design — link unfurlers
 * cannot pass Access (VISION.md anti-goals).
 */

export function snapshotObjectKey(slug: string, prefix?: string): string {
  const cleaned = (prefix ?? 'snapshots/').replace(/^\/+/, '');
  const normalized = cleaned === '' || cleaned.endsWith('/') ? cleaned : `${cleaned}/`;
  return `${normalized}${slug}.html`;
}

export function snapshotPublicPath(slug: string): string {
  return `/snapshots/${encodeURIComponent(slug)}.html`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderSnapshotHtml(args: {
  title: string | null;
  markdown: string;
  slug: string;
  updatedAt: string;
}): string {
  const title = args.title?.trim() || 'Shared Document';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} — Snapshot</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #e7e4dc;
      color: #26251e;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .share-page {
      width: 100%;
      max-width: 1280px;
      margin: 0 auto;
      padding: 24px 16px 40px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .share-page__title { font-size: 28px; font-weight: 650; margin: 8px 2px 0; }
    .share-page__note {
      font-size: 14px;
      line-height: 1.4;
      color: rgba(38,37,30,0.7);
      padding: 0 2px;
    }
    .share-page__markdown {
      width: min(1200px, 100%);
      background: rgba(255,255,255,0.72);
      border: 1px solid rgba(38,37,30,0.12);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 18px 38px rgba(38, 37, 30, 0.08);
    }
    .share-page__markdown-label {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(38,37,30,0.55);
      padding: 14px 18px 0;
    }
    .share-page__markdown pre {
      margin: 0;
      padding: 14px 18px 18px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 14px;
      line-height: 1.55;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .share-page__footer a { color: inherit; }
  </style>
</head>
<body>
  <main class="share-page">
    <h1 class="share-page__title">${escapeHtml(title)}</h1>
    <div class="share-page__note">Read-only snapshot · updated ${escapeHtml(args.updatedAt)}</div>
    <div class="share-page__markdown">
      <div class="share-page__markdown-label">Snapshot</div>
      <pre>${escapeHtml(args.markdown)}</pre>
    </div>
    <div class="share-page__note share-page__footer">
      Live document: <a href="/d/${encodeURIComponent(args.slug)}">/d/${escapeHtml(args.slug)}</a>
    </div>
  </main>
</body>
</html>
`;
}
