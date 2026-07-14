/**
 * Personal library verification (issue #15).
 *
 * Two SSO identities visit different documents; the library must be
 * per-user, show title/role/last-activity, attribute agent-created docs
 * via ownerId, handle deleted docs gracefully, and stay D1-only.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';

const PORT = 8985;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'library-test' };
const JSON_HDRS = { ...AGENT, 'content-type': 'application/json' };
const ALICE = { 'x-dev-identity': 'alice.reader@example.com' };
const BOB = { 'x-dev-identity': 'bob.writer@example.com' };

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

async function createDoc(markdown: string, title: string, ownerId?: string) {
  const res = await fetch(`${BASE}/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown, title, ...(ownerId ? { ownerId } : {}) }),
  });
  return (await res.json()) as Record<string, any>;
}

async function openAs(headers: Record<string, string>, slug: string) {
  return fetch(`${BASE}/api/documents/${slug}/open-context`, { headers });
}

async function library(headers: Record<string, string>) {
  const res = await fetch(`${BASE}/api/library`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  try {
    const doc1 = await createDoc('# One\n\nfirst', 'Doc One');
    const doc2 = await createDoc('# Two\n\nsecond', 'Doc Two');
    // Agent-created on Bob's behalf (the contract's ownerId attribution).
    const owned = await createDoc('# Owned\n\nfor bob', 'Bob Owned Doc', 'bob.writer@example.com');

    ok('setup: three documents', !!doc1.slug && !!doc2.slug && !!owned.slug);

    // Alice opens doc1 + doc2; Bob opens doc2 only.
    ok('alice opens doc1', (await openAs(ALICE, doc1.slug)).status === 200);
    ok('alice opens doc2', (await openAs(ALICE, doc2.slug)).status === 200);
    ok('bob opens doc2', (await openAs(BOB, doc2.slug)).status === 200);
    await sleep(500); // visits are write-behind

    const alice = await library(ALICE);
    ok('alice library -> 200', alice.status === 200);
    const aliceSlugs = (alice.body.documents as any[]).map((d) => d.slug);
    ok('alice sees both visited docs', aliceSlugs.includes(doc1.slug) && aliceSlugs.includes(doc2.slug), aliceSlugs);
    ok('alice does NOT see bob-owned unvisited doc', !aliceSlugs.includes(owned.slug), aliceSlugs);
    const aliceDoc1 = (alice.body.documents as any[]).find((d) => d.slug === doc1.slug);
    ok('rows carry title, role, last activity', aliceDoc1.title === 'Doc One' && aliceDoc1.role === 'editor' && !!aliceDoc1.lastVisitedAt, aliceDoc1);

    const bob = await library(BOB);
    const bobSlugs = (bob.body.documents as any[]).map((d) => d.slug);
    ok('bob sees only his visited doc', bobSlugs.includes(doc2.slug) && !bobSlugs.includes(doc1.slug), bobSlugs);
    const bobOwned = (bob.body.documents as any[]).find((d) => d.slug === owned.slug);
    ok('agent-created doc attributed to bob via ownerId', !!bobOwned && bobOwned.owned === true, bob.body.documents);

    // Repeat visit bumps the counter (upsert path).
    await openAs(BOB, doc2.slug);
    await sleep(500);
    const bobAgain = await library(BOB);
    const doc2Row = (bobAgain.body.documents as any[]).find((d) => d.slug === doc2.slug);
    ok('repeat visits increment visitCount', Number(doc2Row.visitCount) >= 2, doc2Row);

    // Deleted docs handled gracefully.
    const del = await fetch(`${BASE}/documents/${doc2.slug}/delete`, {
      method: 'POST',
      headers: { ...JSON_HDRS, 'x-bridge-token': doc2.ownerSecret },
    });
    ok('delete doc2 -> 200', del.status === 200);
    const aliceAfter = await library(ALICE);
    ok('library still 200 with a deleted doc', aliceAfter.status === 200);
    const deletedRow = (aliceAfter.body.documents as any[]).find((d) => d.slug === doc2.slug);
    ok('deleted doc listed with its state', deletedRow?.shareState === 'DELETED', deletedRow);

    // HTML view (the built SPA shell — it fetches /api/library itself, so
    // this only asserts the shell is served, not that it contains data)
    // + access rules.
    const htmlRes = await fetch(`${BASE}/library`, { headers: ALICE });
    const html = await htmlRes.text();
    ok(
      '/library serves the SPA shell',
      htmlRes.status === 200 &&
        String(htmlRes.headers.get('content-type')).includes('text/html') &&
        html.includes('id="app"'),
      html.slice(0, 200),
    );
    const agentLib = await library(AGENT);
    ok('agents get 403 from the library JSON', agentLib.status === 403);
    const agentHtmlRes = await fetch(`${BASE}/library`, { headers: AGENT });
    ok('agents get 403 from the library HTML', agentHtmlRes.status === 403);

    console.log(`\nworker-library: ${passed} assertions passed`);
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
