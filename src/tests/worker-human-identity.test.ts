/**
 * Human identity in collab (issue #9).
 *
 * Verifies the SSO default-role flow at the transport level:
 *   - a tokenless authenticated human gets the instance default role
 *     (editor) on an ACTIVE document, and the minted session token
 *     actually connects + edits end-to-end
 *   - the session response carries the verified identity (email sub)
 *   - a presented document token still wins over the default role
 *   - the default role also applies to mutations (/ops), not just reads
 *   - agents without a document token stay 401 (contract unchanged)
 *   - PROOF_DEFAULT_HUMAN_ROLE=commenter demotes tokenless humans
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import type { WorkerHandle } from './worker-harness';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8979;
const BASE = `http://127.0.0.1:${PORT}`;
const HUMAN = { 'x-dev-identity': 'pat.example@example.com' };
const AGENT = { 'x-dev-agent': 'identity-test' };
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

async function createDoc(): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Identity\n\nSeed.', title: 'Identity' }),
  });
  if (res.status !== 200) throw new Error(`create -> ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

async function session(slug: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}/documents/${slug}/collab-session`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function openContext(slug: string, headers: Record<string, string>) {
  const res = await fetch(`${BASE}/api/documents/${slug}/open-context`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** Mirrors ShareClient.isCollabSessionInfo — the web client's strict gate. */
function isClientValidSession(value: any): boolean {
  return (
    !!value &&
    typeof value.docId === 'string' &&
    value.docId.length > 0 &&
    typeof value.slug === 'string' &&
    ['viewer', 'commenter', 'editor', 'owner_bot'].includes(value.role) &&
    ['ACTIVE', 'PAUSED', 'REVOKED', 'DELETED'].includes(value.shareState) &&
    typeof value.accessEpoch === 'number' &&
    value.syncProtocol === 'pm-yjs-v1' &&
    typeof value.collabWsUrl === 'string' &&
    value.collabWsUrl.length > 0 &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    typeof value.snapshotVersion === 'number'
  );
}

async function main() {
  await applyLocalMigrations();

  // --- Config 1: instance defaults (editor) --------------------------------
  let worker: WorkerHandle = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  const cleanups: Array<() => void> = [];
  try {
    const doc = await createDoc();
    const slug = doc.slug as string;

    // Tokenless human -> default editor role, identity in the payload.
    const human = await session(slug, HUMAN);
    ok('tokenless human -> 200', human.status === 200, human);
    ok('default role is editor', human.body.session.role === 'editor', human.body);
    ok('session sub is the SSO email', human.body.session.sub === 'pat.example@example.com', human.body.session);
    ok(
      'session identity is the human',
      human.body.session.identity?.kind === 'human' &&
        human.body.session.identity?.email === 'pat.example@example.com',
      human.body.session,
    );

    // The session shape passes the web client's strict validator, with
    // capabilities alongside (otherwise the browser degrades to no-collab).
    ok('session passes client-side validation', isClientValidSession(human.body.session), human.body.session);
    ok(
      'collab-session includes capabilities',
      human.body.capabilities?.canRead === true &&
        human.body.capabilities?.canComment === true &&
        human.body.capabilities?.canEdit === true,
      human.body,
    );

    // open-context: the /d/:slug boot endpoint, one round trip.
    const ctx = await openContext(slug, HUMAN);
    ok('open-context tokenless human -> 200', ctx.status === 200, ctx);
    ok('open-context returns the document', String(ctx.body.doc?.markdown).includes('Seed.'), ctx.body.doc);
    ok('open-context session passes client validation', isClientValidSession(ctx.body.session), ctx.body.session);
    ok(
      'open-context carries verified identity',
      ctx.body.session?.identity?.email === 'pat.example@example.com',
      ctx.body.session,
    );
    ok(
      'open-context capabilities for default editor',
      ctx.body.capabilities?.canEdit === true,
      ctx.body,
    );
    const agentCtx = await openContext(slug, AGENT);
    ok('open-context tokenless agent -> 401', agentCtx.status === 401, agentCtx);

    // events/pending: the web client polls this for cross-instance refresh
    // signals even in tokenless sessions, so it needs the same default-role
    // fallback as open-context/collab-session — agents still need a token.
    const humanEvents = await fetch(`${BASE}/documents/${slug}/events/pending?after=0`, { headers: HUMAN });
    const humanEventsBody = await humanEvents.json().catch(() => null);
    ok('tokenless human events/pending -> 200', humanEvents.status === 200, humanEventsBody);
    const agentEvents = await fetch(`${BASE}/documents/${slug}/events/pending?after=0`, { headers: AGENT });
    ok('tokenless agent events/pending stays 401', agentEvents.status === 401, agentEvents);

    // state: same default-role parity (issue #49) — a delegated agent
    // entering with its Operator's credential reads tokenlessly too.
    const humanState = await fetch(`${BASE}/documents/${slug}/state`, { headers: HUMAN });
    ok('tokenless human state -> 200', humanState.status === 200, humanState.status);
    const delegatedState = await fetch(`${BASE}/documents/${slug}/state`, {
      headers: { ...HUMAN, 'x-agent-id': 'claude-code' },
    });
    ok('tokenless delegated-agent state -> 200', delegatedState.status === 200, delegatedState.status);
    const agentState = await fetch(`${BASE}/documents/${slug}/state`, { headers: AGENT });
    ok('tokenless agent state stays 401', agentState.status === 401, agentState.status);

    // access-links: default-role editors may mint (issue #49) — this is
    // what makes the agent invite self-sufficient from a clean URL.
    const humanMint = await fetch(`${BASE}/documents/${slug}/access-links`, {
      method: 'POST',
      headers: { ...HUMAN, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    const humanMintBody = (await humanMint.json().catch(() => null)) as Record<string, any> | null;
    ok('tokenless human mints access link -> 200', humanMint.status === 200, humanMintBody);
    ok(
      'minted link carries token + web url',
      typeof humanMintBody?.accessToken === 'string' &&
        humanMintBody.accessToken.length > 0 &&
        String(humanMintBody?.webShareUrl ?? '').includes('token='),
      humanMintBody,
    );
    const agentMint = await fetch(`${BASE}/documents/${slug}/access-links`, {
      method: 'POST',
      headers: { ...AGENT, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    ok('tokenless agent access-links stays 403', agentMint.status === 403, agentMint.status);

    // ops: default-role parity for mutations, not just reads (a tokenless
    // SSO human accepting a suggestion previously got 401 — /ops resolved
    // role from a presented token alone, with no default-role fallback).
    const humanOps = await fetch(`${BASE}/documents/${slug}/ops`, {
      method: 'POST',
      headers: { ...HUMAN, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'comment.add', payload: { quote: 'Seed', text: 'hi' } }),
    });
    const humanOpsBody = (await humanOps.json().catch(() => null)) as Record<string, any> | null;
    ok('tokenless human ops (comment.add) -> 200', humanOps.status === 200, humanOpsBody);
    const agentOps = await fetch(`${BASE}/documents/${slug}/ops`, {
      method: 'POST',
      headers: { ...AGENT, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'comment.add', payload: { quote: 'Seed', text: 'hi' } }),
    });
    ok('tokenless agent ops stays 401', agentOps.status === 401, agentOps.status);

    // The minted session token works end-to-end: connect, edit, persist.
    const client = connectProvider(slug, human.body.session.token);
    cleanups.push(() => client.provider.destroy());
    ok('tokenless-human session token syncs', await waitSynced(client.provider));
    appendParagraph(client.doc, 'HUMAN-DEFAULT-ROLE-EDIT');
    const state = await waitForAsync(
      async () => {
        const res = await fetch(`${BASE}/documents/${slug}/state`, {
          headers: { ...AGENT, 'x-share-token': doc.accessToken },
        });
        return (await res.json()) as Record<string, any>;
      },
      (s) => String(s.markdown).includes('HUMAN-DEFAULT-ROLE-EDIT'),
    );
    ok('default-role human edit persists', String(state.markdown).includes('HUMAN-DEFAULT-ROLE-EDIT'), state.markdown);

    // A presented document token still wins over the default role.
    const viewerCreate = await fetch(`${BASE}/share/markdown`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({ markdown: '# Viewer\n\nSeed.', role: 'viewer' }),
    });
    const viewerDoc = (await viewerCreate.json()) as Record<string, any>;
    const tokenWins = await session(viewerDoc.slug, {
      ...HUMAN,
      'x-share-token': viewerDoc.accessToken,
    });
    ok('human presenting a viewer token gets viewer, not default', tokenWins.body.session.role === 'viewer', tokenWins.body);
    ok(
      'viewer capabilities exclude comment/edit',
      tokenWins.body.capabilities?.canRead === true &&
        tokenWins.body.capabilities?.canComment === false &&
        tokenWins.body.capabilities?.canEdit === false,
      tokenWins.body,
    );

    // Agents never get a default role.
    const agent = await session(slug, AGENT);
    ok('tokenless agent stays 401', agent.status === 401, agent);
    const agentWithToken = await session(slug, { ...AGENT, 'x-share-token': doc.accessToken });
    ok(
      'agent with token keeps agent identity in session',
      agentWithToken.status === 200 &&
        agentWithToken.body.session.sub === 'agent:identity-test' &&
        agentWithToken.body.session.identity?.kind === 'agent',
      agentWithToken.body,
    );

    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* ignore */ }
    }
    worker.stop();
    await sleep(1_500);

    // --- Config 2: demoted default (commenter) -----------------------------
    worker = await startWorker(PORT, {
      PROOF_DEV_MODE: '1',
      PROOF_DEFAULT_HUMAN_ROLE: 'commenter',
    });
    const doc2 = await createDoc();
    const demoted = await session(doc2.slug as string, HUMAN);
    ok('configured default demotes tokenless humans to commenter', demoted.body.session.role === 'commenter', demoted.body);
    const agent2 = await session(doc2.slug as string, AGENT);
    ok('agents unaffected by default role config', agent2.status === 401, agent2);
    // Below-editor defaults cannot mint access links (issue #49 gate).
    const demotedMint = await fetch(`${BASE}/documents/${doc2.slug}/access-links`, {
      method: 'POST',
      headers: { ...HUMAN, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    ok('commenter-default human cannot mint access links -> 403', demotedMint.status === 403, demotedMint.status);

    console.log(`\nworker-human-identity: ${passed} assertions passed`);
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
