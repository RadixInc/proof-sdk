/**
 * Durability slice verification (issue #8).
 *
 * Boots the Worker under `wrangler dev`, edits through real YProvider
 * clients, then SIGKILLs the dev server and boots a fresh one against the
 * same local DO storage to prove:
 *   - cold start replays snapshot + update log: reads serve the exact
 *     pre-kill projection with no live doc
 *   - CRDT identity survives restarts: a client reconnecting with its
 *     original Y.Doc does not duplicate content (the markdown-rehydration
 *     failure mode)
 *   - update rows are compacted once a snapshot bounds their replay
 *   - the projection health probe replays durable state and matches the
 *     stored projection after every persist cycle
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT_A = 8977;
const PORT_B = 8978;
const AGENT = { 'x-dev-agent': 'durability-test' };
const JSON_HDRS = { ...AGENT, 'content-type': 'application/json' };
const SNAPSHOT_EVERY = 8;
const VARS = {
  PROOF_DEV_MODE: '1',
  PROOF_YJS_SNAPSHOT_EVERY_UPDATES: String(SNAPSHOT_EVERY),
};

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

function connectProvider(
  port: number,
  slug: string,
  token: string,
  doc = new Y.Doc(),
): { doc: Y.Doc; provider: YProvider } {
  const provider = new YProvider(`127.0.0.1:${port}`, slug, doc, {
    prefix: `/documents/${slug}/collab`,
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  return { doc, provider };
}

async function waitSynced(provider: YProvider, ms = 15_000): Promise<boolean> {
  if (provider.synced) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function fragmentText(doc: Y.Doc): string {
  return doc.getXmlFragment('prosemirror').toString();
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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
    await sleep(200);
    last = await probe();
  }
  return last;
}

function appendParagraph(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment('prosemirror');
  doc.transact(() => {
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText(text)]);
    fragment.push([para]);
  });
}

async function getJson(port: number, path: string, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { ...AGENT, 'x-share-token': token },
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function mintSession(port: number, slug: string, token: string): Promise<string> {
  const { status, body } = await getJson(port, `/documents/${slug}/collab-session`, token);
  if (status !== 200) throw new Error(`collab-session -> ${status}`);
  return body.session.token as string;
}

async function main() {
  await applyLocalMigrations();
  let worker = await startWorker(PORT_A, VARS);
  const cleanups: Array<() => void> = [];
  try {
    // --- Setup on worker A -------------------------------------------------
    const createRes = await fetch(`http://127.0.0.1:${PORT_A}/documents`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({
        markdown: '# Durability\n\nSeed paragraph.',
        title: 'Durability',
      }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug);
    const slug = doc.slug as string;
    const token = doc.accessToken as string;

    const sessionA = await mintSession(PORT_A, slug, token);
    const clientOne = connectProvider(PORT_A, slug, sessionA);
    cleanups.push(() => clientOne.provider.destroy());
    ok('client 1 synced', await waitSynced(clientOne.provider));

    appendParagraph(clientOne.doc, 'BEFORE-RESTART');
    let state = await waitForAsync(
      () => getJson(PORT_A, `/documents/${slug}/state`, token).then((r) => r.body),
      (s) => String(s.markdown).includes('BEFORE-RESTART'),
    );
    ok('persist cycle: /state serves the edit', String(state.markdown).includes('BEFORE-RESTART'), state.markdown);
    ok('persist cycle: revision bumped', Number(state.revision) > 1, state.revision);

    let health = await waitForAsync(
      () => getJson(PORT_A, `/documents/${slug}/projection-health`, token).then((r) => r.body),
      (h) => h.pendingUpdates === 0 && h.consistent === true,
    );
    ok('health: durable Yjs state exists', health.hasYjsState === true, health);
    ok('health: projection matches replayed canonical state', health.pendingUpdates === 0 && health.consistent === true, health);

    // --- Compaction under sustained editing --------------------------------
    const editCount = SNAPSHOT_EVERY * 3;
    for (let i = 0; i < editCount; i += 1) {
      appendParagraph(clientOne.doc, `SUSTAINED-EDIT-${i}`);
      await sleep(40); // separate transactions -> separate update rows
    }
    state = await waitForAsync(
      () => getJson(PORT_A, `/documents/${slug}/state`, token).then((r) => r.body),
      (s) => String(s.markdown).includes(`SUSTAINED-EDIT-${editCount - 1}`),
    );
    ok('sustained edits reach /state', String(state.markdown).includes(`SUSTAINED-EDIT-${editCount - 1}`));
    health = await waitForAsync(
      () => getJson(PORT_A, `/documents/${slug}/projection-health`, token).then((r) => r.body),
      (h) => h.snapshotSeq >= SNAPSHOT_EVERY && h.pendingUpdates === 0,
    );
    ok('compaction: a snapshot was taken', health.snapshotSeq >= SNAPSHOT_EVERY, health);
    ok('compaction: covered update rows were deleted', health.updateRows < editCount, health);
    ok('compaction: projection still consistent', health.consistent === true, health);

    const preKillMarkdown = String(state.markdown);
    const preKillRevision = Number(state.revision);

    // --- Kill the server, cold-start a fresh one ---------------------------
    clientOne.provider.destroy();
    worker.stop();
    await sleep(2_000); // let the killed workerd release local DO storage
    worker = await startWorker(PORT_B, VARS);

    // Cold read: RPC path with no live collab room replays the projection.
    const coldState = await getJson(PORT_B, `/documents/${slug}/state`, token);
    ok('cold start: /state returns 200', coldState.status === 200);
    ok('cold start: exact pre-kill markdown', String(coldState.body.markdown) === preKillMarkdown, coldState.body.markdown);
    ok('cold start: revision preserved', Number(coldState.body.revision) === preKillRevision, coldState.body.revision);

    // CRDT identity: reconnect with the ORIGINAL Y.Doc. Under markdown
    // rehydration the server would hold a different CRDT and merging this
    // client's state would duplicate every block.
    const sessionB = await mintSession(PORT_B, slug, token);
    const reconnected = connectProvider(PORT_B, slug, sessionB, clientOne.doc);
    cleanups.push(() => reconnected.provider.destroy());
    ok('reconnected original client synced', await waitSynced(reconnected.provider));
    appendParagraph(reconnected.doc, 'AFTER-RESTART');

    const fresh = connectProvider(PORT_B, slug, sessionB);
    cleanups.push(() => fresh.provider.destroy());
    ok('fresh client synced', await waitSynced(fresh.provider));
    const freshText = await waitForAsync(
      async () => fragmentText(fresh.doc),
      (t) => t.includes('AFTER-RESTART'),
    );
    ok('fresh client sees pre- and post-restart edits', freshText.includes('BEFORE-RESTART') && freshText.includes('AFTER-RESTART'));
    ok('no duplicated content after restart (seed)', occurrences(freshText, 'Seed paragraph.') === 1, freshText);
    ok('no duplicated content after restart (edit)', occurrences(freshText, 'BEFORE-RESTART') === 1, freshText);
    ok('reconnected client sees no duplication either', occurrences(fragmentText(reconnected.doc), 'BEFORE-RESTART') === 1);

    // Post-restart persist cycle keeps the invariant.
    state = await waitForAsync(
      () => getJson(PORT_B, `/documents/${slug}/state`, token).then((r) => r.body),
      (s) => String(s.markdown).includes('AFTER-RESTART'),
    );
    ok('post-restart edit persisted to /state', String(state.markdown).includes('AFTER-RESTART'));
    ok('post-restart revision advanced', Number(state.revision) > preKillRevision, state.revision);
    health = await waitForAsync(
      () => getJson(PORT_B, `/documents/${slug}/projection-health`, token).then((r) => r.body),
      (h) => h.pendingUpdates === 0 && h.consistent === true,
    );
    ok('post-restart projection health holds', health.consistent === true && health.pendingUpdates === 0, health);

    console.log(`\nworker-durability: ${passed} assertions passed`);
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
