/**
 * Suggestion finalization dissolves anchors and defeats resurrection.
 *
 * Root cause of the reappearance loop (#54 could only dampen it): finalizing
 * a suggestion left its `<span data-proof="suggestion">` anchor in the
 * canonical markdown. Clients re-derived the anchor as a fresh "pending"
 * suggestion (status is never serialized into span attrs) and their next
 * marks flush resurrected it — observed live as `suggestion.accepted`
 * followed seconds later by `suggestion.added` for the same mark id.
 *
 * Verifies against a booted Worker:
 *   - accept applies the content AND removes the anchor span from markdown
 *   - reject keeps the original text AND removes the anchor span
 *   - a stale client deleting + re-adding a finalized mark as "pending"
 *     (the path that bypasses the value-level regression guard) is restored
 *     to the finalized status by the DO's registry, with no phantom
 *     suggestion.added event
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8992;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'finalize-test' };
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

async function postOp(slug: string, token: string, body: unknown) {
  const res = await fetch(`${BASE}/documents/${slug}/ops`, {
    method: 'POST',
    headers: { ...JSON_HDRS, 'x-share-token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function fetchEvents(slug: string, token: string): Promise<Array<Record<string, any>>> {
  const res = await fetch(`${BASE}/documents/${slug}/events/pending?after=0&limit=200`, {
    headers: { ...AGENT, 'x-share-token': token },
  });
  const body = (await res.json()) as Record<string, any>;
  return Array.isArray(body.events) ? body.events : [];
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
        markdown:
          '# Finalize\n\nThe quick brown fox jumps over the lazy dog.\n\nA second target sentence for rejection.',
        title: 'Finalize',
      }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug);
    const slug = doc.slug as string;
    const token = doc.accessToken as string;

    const acceptTarget = await postOp(slug, token, {
      type: 'suggestion.add',
      payload: { kind: 'replace', by: 'ai:reviewer', quote: 'quick brown fox', content: 'swift auburn fox' },
    });
    ok('setup: replace suggestion added', acceptTarget.status === 200, acceptTarget.body);
    const acceptId = acceptTarget.body.markId as string;

    const rejectTarget = await postOp(slug, token, {
      type: 'suggestion.add',
      payload: { kind: 'replace', by: 'ai:reviewer', quote: 'second target sentence', content: 'other clause' },
    });
    ok('setup: second suggestion added', rejectTarget.status === 200, rejectTarget.body);
    const rejectId = rejectTarget.body.markId as string;

    // Added while "quick brown fox" is still in the text, so this mark's
    // stabilized target context embeds it — accepting the replace above
    // goes on to invalidate that context.
    const staleContextTarget = await postOp(slug, token, {
      type: 'suggestion.add',
      payload: { kind: 'insert', by: 'ai:reviewer', quote: 'lazy dog', content: ' (eventually)' },
    });
    ok('setup: insert suggestion added', staleContextTarget.status === 200, staleContextTarget.body);
    const staleContextId = staleContextTarget.body.markId as string;

    // Accept: content applied AND anchor span dissolved from the markdown.
    const accepted = await postOp(slug, token, {
      type: 'suggestion.accept',
      payload: { markId: acceptId, by: 'human:editor@example.com' },
    });
    ok('accept -> 200 with accepted status', accepted.status === 200 && accepted.body.marks?.[acceptId]?.status === 'accepted', accepted.body);
    const acceptedMarkdown = String(accepted.body.markdown ?? '');
    ok('accept applied the suggested content', acceptedMarkdown.includes('swift auburn fox'));
    ok('accept removed the anchor span', !acceptedMarkdown.includes(acceptId), acceptedMarkdown);

    // Reject: original text kept, anchor span dissolved.
    const rejected = await postOp(slug, token, {
      type: 'suggestion.reject',
      payload: { markId: rejectId, by: 'human:editor@example.com' },
    });
    ok('reject -> 200 with rejected status', rejected.status === 200 && rejected.body.marks?.[rejectId]?.status === 'rejected', rejected.body);
    const rejectedMarkdown = String(rejected.body.markdown ?? '');
    ok('reject kept the original text', rejectedMarkdown.includes('second target sentence'));
    ok('reject did not apply the content', !rejectedMarkdown.includes('other clause'));
    ok('reject removed the anchor span', !rejectedMarkdown.includes(rejectId), rejectedMarkdown);

    // Accepting a suggestion whose stabilized add-time context was
    // invalidated by the earlier accept must still resolve (context is a
    // disambiguator, not a veto) — this returned 409 ANCHOR_NOT_FOUND
    // before the graduated fallback existed.
    const staleAccepted = await postOp(slug, token, {
      type: 'suggestion.accept',
      payload: { markId: staleContextId, by: 'human:editor@example.com' },
    });
    ok(
      'accept resolves despite stale add-time context',
      staleAccepted.status === 200 && staleAccepted.body.marks?.[staleContextId]?.status === 'accepted',
      staleAccepted.body,
    );
    const staleAcceptedMarkdown = String(staleAccepted.body.markdown ?? '');
    ok('stale-context accept applied the content', staleAcceptedMarkdown.includes('(eventually)'));
    ok('stale-context accept removed the anchor span', !staleAcceptedMarkdown.includes(staleContextId));

    // Resurrection attempt: a stale client deletes the finalized map entry
    // and re-adds it as pending — bypassing the value-overwrite guard.
    const sessRes = await fetch(`${BASE}/documents/${slug}/collab-session`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const session = ((await sessRes.json()) as any).session;
    const stale = connectProvider(slug, session.token);
    cleanups.push(() => stale.provider.destroy());
    ok('stale client synced', await waitSynced(stale.provider));
    const staleMarks = stale.doc.getMap('marks');
    ok('stale client sees accepted status', await waitFor(() => (staleMarks.get(acceptId) as any)?.status === 'accepted'));

    const eventsBefore = await fetchEvents(slug, token);
    const addedBefore = eventsBefore.filter((e) => e.type === 'suggestion.added' && e.data?.markId === acceptId).length;

    stale.doc.transact(() => {
      staleMarks.delete(acceptId);
    });
    await sleep(250);
    stale.doc.transact(() => {
      staleMarks.set(acceptId, {
        kind: 'replace',
        by: 'ai:reviewer',
        status: 'pending',
        quote: 'quick brown fox',
        content: 'swift auburn fox',
      });
    });

    ok(
      'server restores the finalized status over the resurrection',
      await waitFor(() => (staleMarks.get(acceptId) as any)?.status === 'accepted'),
      staleMarks.get(acceptId),
    );

    const stateRes = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...AGENT, 'x-share-token': token },
    });
    const state = (await stateRes.json()) as Record<string, any>;
    ok('state confirms accepted after resurrection attempt', state.marks?.[acceptId]?.status === 'accepted', state.marks?.[acceptId]);

    const eventsAfter = await fetchEvents(slug, token);
    const addedAfter = eventsAfter.filter((e) => e.type === 'suggestion.added' && e.data?.markId === acceptId).length;
    ok('no phantom suggestion.added event was emitted', addedAfter === addedBefore, { addedBefore, addedAfter });

    console.log(`\nworker-suggestion-finalize: ${passed} assertions passed`);
  } finally {
    for (const cleanup of cleanups) cleanup();
    worker.stop();
  }
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
