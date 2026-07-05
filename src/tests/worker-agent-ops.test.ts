/**
 * Agent ops live-propagation verification (issue #10).
 *
 * Boots the Worker, connects a real YProvider "human" client, then drives
 * agent ops over HTTP and asserts:
 *   - a comment added via /ops appears live in the connected client's
 *     'marks' map, correctly anchored to the quoted text
 *   - suggestion.add shows up live as a pending suggestion mark
 *   - idempotent replay does not double-apply across the live doc
 *   - ops persist: marks survive into GET /state after the persist cycle
 *   - anchors resolve against fresh live edits (op after collab typing)
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8981;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'ops-test' };
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

function connectProvider(slug: string, token: string): { doc: Y.Doc; provider: YProvider } {
  const doc = new Y.Doc();
  const provider = new YProvider(`127.0.0.1:${PORT}`, slug, doc, {
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

async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

async function postOp(slug: string, token: string, body: unknown, idempotencyKey?: string) {
  const res = await fetch(`${BASE}/documents/${slug}/ops`, {
    method: 'POST',
    headers: {
      ...JSON_HDRS,
      'x-share-token': token,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
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
        markdown: '# Ops\n\nThe quick brown fox jumps over the lazy dog.',
        title: 'Ops',
      }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug);
    const slug = doc.slug as string;
    const token = doc.accessToken as string;

    const sessRes = await fetch(`${BASE}/documents/${slug}/collab-session`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const session = ((await sessRes.json()) as any).session;
    const human = connectProvider(slug, session.token);
    cleanups.push(() => human.provider.destroy());
    ok('human client synced', await waitSynced(human.provider));
    const liveMarks = human.doc.getMap('marks');

    // Agent comment appears live in the connected client's marks map.
    const comment = await postOp(
      slug,
      token,
      {
        type: 'comment.add',
        payload: { by: 'ai:reviewer', text: 'Nice sentence', quote: 'quick brown fox' },
      },
      'ops-live-comment',
    );
    ok('comment.add -> 200', comment.status === 200, comment.body);
    const markId = comment.body.markId as string;
    ok(
      'human sees the comment live',
      await waitFor(() => liveMarks.has(markId)),
      [...liveMarks.keys()],
    );
    const liveMark = liveMarks.get(markId) as Record<string, any>;
    ok('live comment anchored to the quote', String(liveMark.quote).includes('quick brown fox'), liveMark);
    ok('live comment attributed to the agent', liveMark.by === 'ai:reviewer');

    // Replay: no duplicate mark appears.
    const replay = await postOp(
      slug,
      token,
      {
        type: 'comment.add',
        payload: { by: 'ai:reviewer', text: 'Nice sentence', quote: 'quick brown fox' },
      },
      'ops-live-comment',
    );
    ok('replay returns recorded markId', replay.body.markId === markId);
    await sleep(500);
    ok('replay does not double-apply to the live doc', liveMarks.size === 1, liveMarks.size);

    // Pending suggestion appears live.
    const suggestion = await postOp(slug, token, {
      type: 'suggestion.add',
      payload: { kind: 'replace', by: 'ai:reviewer', quote: 'lazy dog', content: 'sleepy dog' },
    });
    ok('suggestion.add -> 200', suggestion.status === 200, suggestion.body);
    const suggestionId = suggestion.body.markId as string;
    ok('human sees the pending suggestion live', await waitFor(() => liveMarks.has(suggestionId)));
    const liveSuggestion = liveMarks.get(suggestionId) as Record<string, any>;
    ok('suggestion is pending replace with content', liveSuggestion.status === 'pending' && liveSuggestion.kind === 'replace' && liveSuggestion.content === 'sleepy dog', liveSuggestion);

    // Anchor resolution sees fresh collab edits: type a new paragraph live,
    // then anchor a comment to it.
    human.doc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('Freshly typed collaborative paragraph.')]);
      human.doc.getXmlFragment('prosemirror').push([para]);
    });
    // Wait for the client's update to reach the server, then anchor on it.
    let freshComment: Awaited<ReturnType<typeof postOp>> = { status: 0, body: {} };
    const anchored = await waitFor(() => false, 200).then(async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        freshComment = await postOp(slug, token, {
          type: 'comment.add',
          payload: { by: 'ai:reviewer', text: 'On the new text', quote: 'Freshly typed collaborative' },
        });
        if (freshComment.status === 200) return true;
        await sleep(250);
      }
      return false;
    });
    ok('comment anchors to text typed moments ago', anchored && freshComment.status === 200, freshComment.body);

    // Persistence: marks survive into GET /state.
    const state = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const stateBody = (await state.json()) as Record<string, any>;
    ok(
      'persisted state contains all three marks',
      !!stateBody.marks[markId] && !!stateBody.marks[suggestionId] && !!stateBody.marks[freshComment.body.markId],
      Object.keys(stateBody.marks ?? {}),
    );
    ok('persisted revision advanced', Number(stateBody.revision) > 1);

    console.log(`\nworker-agent-ops: ${passed} assertions passed`);
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
