/**
 * Personal library (issue #15): recent and owned documents per SSO
 * identity, keyed by the verified email. Visits are recorded write-behind
 * (ctx.waitUntil) when a human opens a document; queries are D1-only.
 */

export interface LibraryRow {
  slug: string;
  title: string | null;
  shareState: string;
  role: string | null;
  owned: boolean;
  visitCount: number;
  lastVisitedAt: string | null;
  updatedAt: string | null;
}

export async function recordVisit(
  db: D1Database,
  email: string,
  slug: string,
  role: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO document_visits
           (user_id, slug, role, visit_count, first_visited_at, last_visited_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(user_id, slug) DO UPDATE SET
           visit_count = visit_count + 1,
           role = excluded.role,
           last_visited_at = excluded.last_visited_at`,
      )
      .bind(email, slug, role, now, now)
      .run();
  } catch (err) {
    // Visit tracking is best-effort; never surface into the open path.
    console.error('visit record failed', err);
  }
}

/**
 * Recent (visited) + owned documents in one D1 round trip each. Owned rows
 * match documents whose ownerId was set to the email (or the human-actor
 * form of it) — the contract's attribution path for agent-created docs.
 */
export async function queryLibrary(
  db: D1Database,
  email: string,
): Promise<LibraryRow[]> {
  const visited = await db
    .prepare(
      `SELECT v.slug, v.role, v.visit_count, v.last_visited_at,
              d.title, d.share_state, d.updated_at, d.owner_id
         FROM document_visits v
         LEFT JOIN documents d ON d.slug = v.slug
        WHERE v.user_id = ?
        ORDER BY v.last_visited_at DESC
        LIMIT 100`,
    )
    .bind(email)
    .all();
  const owned = await db
    .prepare(
      `SELECT slug, title, share_state, updated_at, owner_id
         FROM documents
        WHERE owner_id = ? OR owner_id = ?
        ORDER BY updated_at DESC
        LIMIT 100`,
    )
    .bind(email, `human:${email}`)
    .all();

  const rows = new Map<string, LibraryRow>();
  for (const r of (visited.results ?? []) as Record<string, unknown>[]) {
    rows.set(String(r.slug), {
      slug: String(r.slug),
      title: r.title === null || r.title === undefined ? null : String(r.title),
      shareState: r.share_state ? String(r.share_state) : 'UNKNOWN',
      role: r.role === null ? null : String(r.role),
      owned:
        r.owner_id === email || r.owner_id === `human:${email}`,
      visitCount: Number(r.visit_count),
      lastVisitedAt: String(r.last_visited_at),
      updatedAt: r.updated_at ? String(r.updated_at) : null,
    });
  }
  for (const r of (owned.results ?? []) as Record<string, unknown>[]) {
    const slug = String(r.slug);
    const existing = rows.get(slug);
    if (existing) {
      existing.owned = true;
      continue;
    }
    rows.set(slug, {
      slug,
      title: r.title === null || r.title === undefined ? null : String(r.title),
      shareState: r.share_state ? String(r.share_state) : 'UNKNOWN',
      role: 'owner',
      owned: true,
      visitCount: 0,
      lastVisitedAt: null,
      updatedAt: r.updated_at ? String(r.updated_at) : null,
    });
  }
  return [...rows.values()].sort((a, b) =>
    String(b.lastVisitedAt ?? b.updatedAt ?? '').localeCompare(
      String(a.lastVisitedAt ?? a.updatedAt ?? ''),
    ),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLibraryHtml(email: string, rows: LibraryRow[]): string {
  const items = rows
    .map((row) => {
      const gone = row.shareState !== 'ACTIVE';
      const title = row.title?.trim() || row.slug;
      const label = gone
        ? `<span class="lib__title lib__title--gone">${escapeHtml(title)}</span>`
        : `<a class="lib__title" href="/d/${encodeURIComponent(row.slug)}">${escapeHtml(title)}</a>`;
      const meta = [
        row.owned ? 'owned' : null,
        row.role && !row.owned ? row.role : null,
        gone ? row.shareState.toLowerCase() : null,
        row.lastVisitedAt
          ? `visited ${escapeHtml(row.lastVisitedAt.slice(0, 16).replace('T', ' '))}`
          : null,
        row.updatedAt
          ? `updated ${escapeHtml(row.updatedAt.slice(0, 16).replace('T', ' '))}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li class="lib__item">${label}<span class="lib__meta">${meta}</span></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Library</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0; min-height: 100vh; background: #e7e4dc; color: #26251e;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .lib { max-width: 760px; margin: 0 auto; padding: 40px 16px; }
    .lib__heading { font-size: 26px; font-weight: 650; margin: 0 0 4px; }
    .lib__who { font-size: 13px; color: rgba(38,37,30,0.6); margin-bottom: 24px; }
    .lib__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .lib__item {
      background: rgba(255,255,255,0.72); border: 1px solid rgba(38,37,30,0.12);
      border-radius: 12px; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px;
    }
    .lib__title { font-size: 16px; font-weight: 600; color: inherit; text-decoration: none; }
    .lib__title:hover { text-decoration: underline; }
    .lib__title--gone { color: rgba(38,37,30,0.45); }
    .lib__meta { font-size: 12px; color: rgba(38,37,30,0.55); }
    .lib__empty { color: rgba(38,37,30,0.6); }
  </style>
</head>
<body>
  <main class="lib">
    <h1 class="lib__heading">Library</h1>
    <div class="lib__who">${escapeHtml(email)}</div>
    ${rows.length === 0 ? '<p class="lib__empty">No documents yet — open a shared link and it will show up here.</p>' : `<ul class="lib__list">\n${items}\n</ul>`}
  </main>
</body>
</html>
`;
}
