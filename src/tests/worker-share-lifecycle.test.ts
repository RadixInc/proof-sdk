/**
 * Share lifecycle verification (issue #13).
 *
 * Boots the Worker with a commenter instance default so token elevation is
 * observable, then walks the lifecycle:
 *   - an editor access-link elevates a human above the commenter default
 *   - pause: live collab connection torn down within seconds, new opens
 *     blocked for tokens AND default-role humans, owner retains access
 *   - resume restores access and collab
 *   - revoke permanently invalidates document tokens (even after resume)
 *   - delete -> 410 everywhere
 *   - every transition emits an agent event
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8983;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'lifecycle-test' };
const HUMAN = { 'x-dev-identity': 'pat.example@example.com' };
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

async function post(path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function get(path: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, {
    PROOF_DEV_MODE: '1',
    PROOF_DEFAULT_HUMAN_ROLE: 'commenter',
  });
  const cleanups: Array<() => void> = [];
  try {
    const created = await post('/documents', JSON_HDRS, {
      markdown: '# Lifecycle\n\nShared body.',
      title: 'Lifecycle',
    });
    const slug = created.body.slug as string;
    const accessToken = created.body.accessToken as string;
    const ownerSecret = created.body.ownerSecret as string;
    ok('setup: document created', created.status === 200);
    const ownerHdr = { ...AGENT, 'x-bridge-token': ownerSecret };
    const tokenHdr = { ...AGENT, 'x-share-token': accessToken };

    // --- Token elevation above the commenter instance default -------------
    const humanDefault = await get(`/documents/${slug}/collab-session`, HUMAN);
    ok('tokenless human gets commenter default', humanDefault.body.session.role === 'commenter', humanDefault.body);
    const minted = await post(`/documents/${slug}/access-links`, ownerHdr, { role: 'editor' });
    ok('owner mints editor access-link', minted.status === 200 && minted.body.role === 'editor' && !!minted.body.accessToken, minted.body);
    ok('access-link webShareUrl carries token', String(minted.body.webShareUrl).includes('token='), minted.body.webShareUrl);
    const elevated = await get(`/documents/${slug}/collab-session`, {
      ...HUMAN,
      'x-share-token': minted.body.accessToken,
    });
    ok('editor token elevates human above default', elevated.body.session.role === 'editor', elevated.body);
    const viewerMint = await post(`/documents/${slug}/access-links`, { ...AGENT, 'x-share-token': minted.body.accessToken }, { role: 'viewer' });
    ok('editor token can mint links', viewerMint.status === 200);
    const viewerCannotMint = await post(`/documents/${slug}/access-links`, { ...AGENT, 'x-share-token': viewerMint.body.accessToken }, { role: 'editor' });
    ok('viewer token cannot mint links', viewerCannotMint.status === 403);

    // --- Pause: disconnects live sessions, blocks opens --------------------
    const session = await get(`/documents/${slug}/collab-session`, tokenHdr);
    const live = connectProvider(slug, session.body.session.token);
    cleanups.push(() => live.provider.destroy());
    ok('live client synced before pause', await waitSynced(live.provider));

    const pausedByNonOwner = await post(`/documents/${slug}/pause`, tokenHdr);
    ok('pause with access token -> 403', pausedByNonOwner.status === 403);
    const paused = await post(`/documents/${slug}/pause`, ownerHdr);
    ok('pause with ownerSecret -> 200 PAUSED', paused.status === 200 && paused.body.shareState === 'PAUSED', paused.body);

    ok(
      'live non-owner session disconnected within seconds',
      await waitFor(() => !live.provider.wsconnected, 8_000),
    );
    const pausedState = await get(`/documents/${slug}/state`, tokenHdr);
    ok('paused: token state read -> 403', pausedState.status === 403);
    const pausedHuman = await get(`/api/documents/${slug}/open-context`, HUMAN);
    ok('paused: default-role human open -> 403', pausedHuman.status === 403);
    const pausedSession = await get(`/documents/${slug}/collab-session`, tokenHdr);
    ok('paused: new collab session -> 403', pausedSession.status === 403);
    const staleReconnect = connectProvider(slug, session.body.session.token);
    cleanups.push(() => staleReconnect.provider.destroy());
    ok('paused: stale session token never syncs', !(await waitSynced(staleReconnect.provider, 4_000)));
    const ownerStillReads = await get(`/documents/${slug}/state`, ownerHdr);
    ok('paused: owner still reads state', ownerStillReads.status === 200 && ownerStillReads.body.shareState === 'PAUSED');

    // --- Resume restores access --------------------------------------------
    const resumed = await post(`/documents/${slug}/resume`, ownerHdr);
    ok('resume -> 200 ACTIVE', resumed.status === 200 && resumed.body.shareState === 'ACTIVE');
    const resumedState = await get(`/documents/${slug}/state`, tokenHdr);
    ok('resumed: token read works again', resumedState.status === 200);
    const resumedHuman = await get(`/api/documents/${slug}/open-context`, HUMAN);
    ok('resumed: human default role restored', resumedHuman.status === 200 && resumedHuman.body.session.role === 'commenter');
    const freshSession = await get(`/documents/${slug}/collab-session`, tokenHdr);
    const reconnected = connectProvider(slug, freshSession.body.session.token);
    cleanups.push(() => reconnected.provider.destroy());
    ok('resumed: fresh collab session syncs', await waitSynced(reconnected.provider));

    // --- Revoke permanently invalidates tokens ------------------------------
    const revoked = await post(`/documents/${slug}/revoke`, ownerHdr);
    ok('revoke -> 200 REVOKED', revoked.status === 200 && revoked.body.shareState === 'REVOKED');
    const revokedState = await get(`/documents/${slug}/state`, tokenHdr);
    ok('revoked: token read -> 403', revokedState.status === 403);
    const resumedAfterRevoke = await post(`/documents/${slug}/resume`, ownerHdr);
    ok('resume after revoke -> ACTIVE', resumedAfterRevoke.status === 200);
    const tokenAfterRevoke = await get(`/documents/${slug}/state`, tokenHdr);
    ok('revoked tokens stay dead after resume', tokenAfterRevoke.status === 401, tokenAfterRevoke);
    const elevatedAfterRevoke = await get(`/documents/${slug}/collab-session`, {
      ...HUMAN,
      'x-share-token': minted.body.accessToken,
    });
    ok('minted links are also revoked (default role applies instead)', elevatedAfterRevoke.body.session.role === 'commenter', elevatedAfterRevoke.body);
    const ownerAfterRevoke = await get(`/documents/${slug}/state`, ownerHdr);
    ok('ownerSecret survives revoke', ownerAfterRevoke.status === 200);

    // --- Transitions emitted as agent events --------------------------------
    const events = await get(`/documents/${slug}/events/pending?after=0&limit=200`, ownerHdr);
    const types = (events.body.events as any[]).map((e) => e.type);
    ok(
      'share-state transitions emit events',
      types.includes('document.paused') && types.includes('document.resumed') && types.includes('document.revoked'),
      types,
    );

    // --- Delete -------------------------------------------------------------
    const deleted = await post(`/documents/${slug}/delete`, ownerHdr);
    ok('delete -> 200 DELETED', deleted.status === 200 && deleted.body.shareState === 'DELETED');
    const deletedRead = await get(`/documents/${slug}/state`, ownerHdr);
    ok('deleted: state read -> 410', deletedRead.status === 410);
    const deletedHuman = await get(`/api/documents/${slug}/open-context`, HUMAN);
    ok('deleted: human open -> 410', deletedHuman.status === 410);

    console.log(`\nworker-share-lifecycle: ${passed} assertions passed`);
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
