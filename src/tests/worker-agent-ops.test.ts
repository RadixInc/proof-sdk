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

    // --- write ops under live concurrency (issue #11) -----------------------
    // The pending suggestion replaces 'lazy dog' -> 'sleepy dog' in the same
    // paragraph the human is actively typing into. Both must survive.
    const fragment = human.doc.getXmlFragment('prosemirror');
    const paragraph = (fragment.toArray() as Y.XmlElement[]).find((node) =>
      node.toString().includes('lazy dog'),
    );
    ok('found live paragraph with suggestion target', !!paragraph);
    const textNode = paragraph!.get(0) as Y.XmlText;

    const typed: string[] = [];
    const typeChar = (ch: string) => {
      human.doc.transact(() => {
        textNode.insert(textNode.length, ch);
      });
      typed.push(ch);
    };
    const typingDone = (async () => {
      for (const ch of 'abcde') {
        typeChar(ch);
        await sleep(30);
      }
    })();
    await sleep(60); // typing is in flight
    const acceptRes = await postOp(slug, token, {
      type: 'suggestion.accept',
      payload: { markId: suggestionId },
    });
    ok('suggestion.accept during live typing -> 200', acceptRes.status === 200, acceptRes.body);
    await typingDone;
    for (const ch of 'fghij') {
      typeChar(ch);
      await sleep(30);
    }

    const converged = await waitFor(() => {
      const text = human.doc.getXmlFragment('prosemirror').toString();
      return text.includes('sleepy dog') && text.includes('abcde') && text.includes('fghij');
    }, 15_000);
    const finalText = human.doc.getXmlFragment('prosemirror').toString();
    ok('accept + concurrent keystrokes both survive', converged, finalText);
    ok('no lost or duplicated replacement', !finalText.includes('lazy dog') && (finalText.match(/sleepy dog/g) ?? []).length === 1, finalText);
    ok('all ten concurrent keystrokes present in order', finalText.includes('abcde') && finalText.includes('fghij'), finalText);

    // rewrite.apply (changes mode) while the human keeps editing elsewhere.
    const preRewrite = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const preRevision = Number(((await preRewrite.json()) as any).revision);
    const rewriteTyping = (async () => {
      for (const ch of 'klmno') {
        typeChar(ch);
        await sleep(30);
      }
    })();
    const rewriteRes = await postOp(slug, token, {
      type: 'rewrite.apply',
      payload: {
        by: 'ai:rewriter',
        changes: [{ find: 'quick brown fox', replace: 'QUICK BROWN FOX' }],
        baseRevision: preRevision,
      },
    });
    await rewriteTyping;
    ok('rewrite.apply during live typing -> 200', rewriteRes.status === 200, rewriteRes.body);
    const rewriteConverged = await waitFor(() => {
      const text = human.doc.getXmlFragment('prosemirror').toString();
      return text.includes('QUICK BROWN FOX') && text.includes('klmno');
    }, 15_000);
    ok('rewrite + surrounding concurrent edits both survive', rewriteConverged, human.doc.getXmlFragment('prosemirror').toString());
    ok(
      'rewrite recorded agent provenance',
      Object.values(rewriteRes.body.marks as Record<string, any>).some(
        (m) => m.kind === 'authored' && m.by === 'ai:rewriter',
      ),
    );

    // Everything lands in the persisted projection.
    const finalState = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const finalBody = (await finalState.json()) as Record<string, any>;
    const persisted = await waitFor(() => false, 800).then(async () => {
      const res = await fetch(`${BASE}/documents/${slug}/state`, {
        headers: { ...AGENT, 'x-share-token': token },
      });
      return (await res.json()) as Record<string, any>;
    });
    ok(
      'persisted projection reflects accept + rewrite + keystrokes',
      String(persisted.markdown).includes('sleepy dog') &&
        String(persisted.markdown).includes('QUICK BROWN FOX') &&
        String(persisted.markdown).includes('klmno'),
      persisted.markdown ?? finalBody.markdown,
    );

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
