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
