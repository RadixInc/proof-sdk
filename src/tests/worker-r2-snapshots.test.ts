/**
 * R2 HTML snapshot verification (issue #14).
 *
 * Boots the Worker (wrangler dev simulates R2 locally) and asserts:
 *   - creating a document yields a working snapshotUrl that renders the
 *     document read-only with no collab session
 *   - snapshot content refreshes after collab edits within the persist
 *     cadence
 *   - snapshot routes respect the identity gate and share state
 *     (paused/revoked stop serving; resume restores)
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8984;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'snapshot-test' };
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

async function waitForAsync<T>(
  probe: () => Promise<T>,
  cond: (value: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await probe();
  while (Date.now() < deadline) {
    if (cond(last)) return last;
    await sleep(250);
    last = await probe();
  }
  return last;
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  const cleanups: Array<() => void> = [];
  try {
    const createRes = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({
        markdown: '# Snapshot Doc\n\nOriginal snapshot body.',
        title: 'Snapshot Doc',
      }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    const slug = doc.slug as string;
    ok('create returns a snapshotUrl', typeof doc.snapshotUrl === 'string' && doc.snapshotUrl.includes(`/snapshots/${slug}.html`), doc.snapshotUrl);

    const snapPath = `/snapshots/${slug}.html`;
    const snap = await fetch(`${BASE}${snapPath}`, { headers: AGENT });
    ok('snapshot serves -> 200 text/html', snap.status === 200 && String(snap.headers.get('content-type')).includes('text/html'));
    const html = await snap.text();
    ok('snapshot renders title + content read-only', html.includes('Snapshot Doc') && html.includes('Original snapshot body.') && !html.includes('collab-session'), html.slice(0, 200));

    // Identity gating of /snapshots/* is the Worker-wide edge gate (routes
    // after resolveIdentity), pinned by worker-access-identity.test.ts —
    // not re-asserted here because local .dev.vars can inject DEV_IDENTITY.

    // Refresh after a collab edit within the persist cadence.
    const sessRes = await fetch(`${BASE}/documents/${slug}/collab-session`, {
      headers: { ...AGENT, 'x-share-token': doc.accessToken },
    });
    const session = ((await sessRes.json()) as any).session;
    const ydoc = new Y.Doc();
    const provider = new YProvider(`127.0.0.1:${PORT}`, slug, ydoc, {
      prefix: `/documents/${slug}/collab`,
      params: { token: session.token },
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    cleanups.push(() => provider.destroy());
    await new Promise<void>((resolve) => {
      provider.on('synced', () => resolve());
      setTimeout(() => resolve(), 10_000);
    });
    ydoc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('EDITED-AFTER-CREATE')]);
      ydoc.getXmlFragment('prosemirror').push([para]);
    });
    const refreshed = await waitForAsync(
      async () => (await (await fetch(`${BASE}${snapPath}`, { headers: AGENT })).text()),
      (body) => body.includes('EDITED-AFTER-CREATE'),
    );
    ok('snapshot refreshes after edits within persist cadence', refreshed.includes('EDITED-AFTER-CREATE'));

    // Share state gates.
    const ownerHdr = { ...JSON_HDRS, 'x-bridge-token': doc.ownerSecret };
    const paused = await fetch(`${BASE}/documents/${slug}/pause`, { method: 'POST', headers: ownerHdr });
    ok('pause -> 200', paused.status === 200);
    const pausedSnap = await fetch(`${BASE}${snapPath}`, { headers: AGENT });
    ok('paused doc stops serving snapshot', pausedSnap.status === 403);
    const resumeRes = await fetch(`${BASE}/documents/${slug}/resume`, { method: 'POST', headers: ownerHdr });
    const resumeBody = (await resumeRes.json()) as Record<string, any>;
    ok('resume returns snapshotUrl', String(resumeBody.snapshotUrl).includes(snapPath));
    const resumedSnap = await fetch(`${BASE}${snapPath}`, { headers: AGENT });
    ok('resumed doc serves snapshot again', resumedSnap.status === 200 && (await resumedSnap.text()).includes('EDITED-AFTER-CREATE'));
    const revoked = await fetch(`${BASE}/documents/${slug}/revoke`, { method: 'POST', headers: ownerHdr });
    ok('revoke -> 200', revoked.status === 200);
    const revokedSnap = await fetch(`${BASE}${snapPath}`, { headers: AGENT });
    ok('revoked doc stops serving snapshot', revokedSnap.status === 403);

    console.log(`\nworker-r2-snapshots: ${passed} assertions passed`);
  } finally {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    worker.stop();
  }
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
