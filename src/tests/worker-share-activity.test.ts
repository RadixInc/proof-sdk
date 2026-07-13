/**
 * "View activity" (Share menu) history endpoint.
 *
 * GET /documents/:slug/activity is a new, human-facing read of the same
 * document_event log the Agent Bridge's /events/pending polls — but
 * newest-first and shaped for display, not agent poll/ack. See
 * docs/adr/2026-07-share-activity-history-view.md.
 */

import { applyLocalMigrations, finish, startWorker } from './worker-harness';

const PORT = 8993;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'share-activity-test' };
const JSON_HDRS = { ...AGENT, 'content-type': 'application/json' };

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

async function postOp(slug: string, token: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/documents/${slug}/ops`, {
    method: 'POST',
    headers: { ...JSON_HDRS, ...extraHeaders, 'x-share-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function fetchActivity(slug: string, token: string, query = '') {
  const res = await fetch(`${BASE}/documents/${slug}/activity${query}`, {
    headers: { ...AGENT, 'x-share-token': token },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  try {
    const createRes = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({ markdown: '# Activity\n\nSome body text here.', title: 'Activity' }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug);
    const slug = doc.slug as string;
    const token = doc.accessToken as string;

    const commentRes = await postOp(slug, token, {
      type: 'comment.add',
      payload: { by: 'human:reviewer@example.com', text: 'first comment', quote: 'body text' },
    });
    ok('setup: comment added', commentRes.status === 200, commentRes.body);

    const activity = await fetchActivity(slug, token);
    ok('GET /documents/:slug/activity -> 200', activity.status === 200, activity.body);
    ok('activity: items array present', Array.isArray(activity.body.items), activity.body);
    ok(
      'activity: comment.added is present',
      activity.body.items.some((item: any) => item.type === 'comment.added'),
      activity.body.items,
    );

    // A second, later action must appear before the first one — this is a
    // history viewer (newest-first), not an agent poll cursor (oldest-first).
    const stateRes = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const baseRevision = Number(((await stateRes.json()) as any).revision);
    const rewriteRes = await postOp(slug, token, {
      type: 'rewrite.apply',
      payload: { by: 'ai:rewriter', changes: [{ find: 'Some body text', replace: 'Rewritten body text' }], baseRevision },
    });
    ok('setup: rewrite applied', rewriteRes.status === 200, rewriteRes.body);

    const afterRewrite = await fetchActivity(slug, token);
    const types = afterRewrite.body.items.map((item: any) => item.type);
    ok(
      'activity: newest event (rewrite) sorts before older event (comment)',
      types.indexOf('document.rewritten') < types.indexOf('comment.added'),
      types,
    );
    const ids = afterRewrite.body.items.map((item: any) => Number(item.id));
    ok(
      'activity: ids strictly decreasing (newest-first)',
      ids.every((id: number, i: number) => i === 0 || id < ids[i - 1]),
      ids,
    );

    ok(
      'activity: items omit poll/ack internals (ackedAt/ackedBy/cursor)',
      afterRewrite.body.items.every((item: any) => !('ackedAt' in item) && !('ackedBy' in item)) && !('cursor' in afterRewrite.body),
      afterRewrite.body,
    );
    ok(
      'activity: items carry id/type/actor/data/createdAt',
      afterRewrite.body.items.every((item: any) =>
        typeof item.id === 'number' && typeof item.type === 'string' && 'actor' in item && 'data' in item && typeof item.createdAt === 'string'),
      afterRewrite.body.items,
    );

    const delegated = await postOp(
      slug,
      token,
      { type: 'comment.add', payload: { text: 'from a delegated agent', quote: 'Rewritten body text' } },
      { 'x-dev-identity': 'operator@example.com', 'x-agent-id': 'claude-code' },
    );
    ok('setup: delegated comment added', delegated.status === 200, delegated.body);

    const afterDelegated = await fetchActivity(slug, token);
    const delegatedItem = afterDelegated.body.items.find(
      (item: any) => item.type === 'comment.added' && item.actor === 'ai:claude-code',
    );
    ok('activity: delegated agent event records operator', delegatedItem?.operator === 'operator@example.com', afterDelegated.body.items);

    const limited = await fetchActivity(slug, token, '?limit=2');
    ok('activity: ?limit=2 returns exactly 2 items', limited.body.items.length === 2, limited.body.items);
    ok(
      'activity: ?limit=2 returns the 2 most recent (same as unbounded, truncated)',
      limited.body.items[0].id === afterDelegated.body.items[0].id && limited.body.items[1].id === afterDelegated.body.items[1].id,
      { limited: limited.body.items, afterDelegated: afterDelegated.body.items },
    );

    const noTok = await fetch(`${BASE}/documents/${slug}/activity`, { headers: AGENT });
    ok('activity without token -> 401', noTok.status === 401);

    const viewerShare = await fetch(`${BASE}/share/markdown`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({ markdown: '# Viewer\n\nviewer body', role: 'viewer' }),
    });
    const viewerDoc = (await viewerShare.json()) as Record<string, any>;
    const viewerActivity = await fetchActivity(viewerDoc.slug, viewerDoc.accessToken);
    ok('activity with viewer role -> 200 (matches /events/pending parity)', viewerActivity.status === 200, viewerActivity.body);

    console.log(`\nworker-share-activity: ${passed} assertions passed`);
  } finally {
    worker.stop();
  }
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
