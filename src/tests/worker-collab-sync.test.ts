/**
 * Realtime collab slice verification (issue #7).
 *
 * Boots the Worker under `wrangler dev` and verifies the y-partyserver room
 * end-to-end with real YProvider clients from Node:
 *   - server-side hydration: created markdown appears in the synced Y.Doc
 *   - two clients converge on live edits
 *   - onSave persistence: edits round-trip into GET /state markdown
 *   - viewer-role connections are read-only (server drops their writes)
 *   - forged/missing collab tokens are refused
 *   - collab-refresh mints a usable replacement token
 */

import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';

const PORT = 8975;
const BASE = `http://localhost:${PORT}`;
const AGENT = { 'x-dev-agent': 'collab-test' };
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

async function startWorker(): Promise<ChildProcess> {
  if (!existsSync('wrangler.jsonc')) {
    copyFileSync('wrangler.example.jsonc', 'wrangler.jsonc');
  }
  await new Promise<void>((resolve, reject) => {
    const mig = spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'proof-sdk', '--local'], { stdio: 'ignore' });
    mig.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`migrations exit ${code}`))));
  });
  const proc = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(PORT), '--var', 'PROOF_DEV_MODE:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return proc;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  proc.kill('SIGTERM');
  throw new Error('wrangler dev did not become healthy');
}

function connectProvider(slug: string, token: string): { doc: Y.Doc; provider: YProvider } {
  const doc = new Y.Doc();
  const provider = new YProvider(`localhost:${PORT}`, slug, doc, {
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

async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

function appendParagraph(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment('prosemirror');
  doc.transact(() => {
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText(text)]);
    fragment.push([para]);
  });
}

async function main() {
  const proc = await startWorker();
  const cleanups: Array<() => void> = [];
  try {
    // Create a document with recognizable content + a separate viewer token.
    const createRes = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({ markdown: '# Hello Collab\n\nSeed paragraph.', title: 'Collab' }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug);
    const viewerCreate = await fetch(`${BASE}/share/markdown`, {
      method: 'POST',
      headers: JSON_HDRS,
      body: JSON.stringify({ markdown: '# Viewer Doc\n\nViewer seed.', role: 'viewer' }),
    });
    const viewerDoc = (await viewerCreate.json()) as Record<string, any>;
    ok('setup: viewer-role document created', viewerCreate.status === 200);

    // Collab session minting
    const sessRes = await fetch(`${BASE}/documents/${doc.slug}/collab-session`, {
      headers: { ...AGENT, 'x-share-token': doc.accessToken },
    });
    ok('collab-session -> 200', sessRes.status === 200);
    const session = ((await sessRes.json()) as any).session;
    ok('session has token + collabWsUrl + role', !!session.token && String(session.collabWsUrl).includes(`/documents/${doc.slug}/collab`) && session.role === 'editor');
    const noTokSess = await fetch(`${BASE}/documents/${doc.slug}/collab-session`, { headers: AGENT });
    ok('collab-session without doc token -> 401', noTokSess.status === 401);

    // Two clients connect and hydrate
    const a = connectProvider(doc.slug, session.token);
    const b = connectProvider(doc.slug, session.token);
    cleanups.push(() => a.provider.destroy(), () => b.provider.destroy());
    ok('client A synced', await waitSynced(a.provider));
    ok('client B synced', await waitSynced(b.provider));
    ok('hydration: A sees seeded markdown', await waitFor(() => fragmentText(a.doc).includes('Hello Collab')), fragmentText(a.doc).slice(0, 200));
    ok('hydration: B sees seeded markdown', fragmentText(b.doc).includes('Hello Collab'));

    // Live edit propagation A -> B
    appendParagraph(a.doc, 'LIVE-EDIT-FROM-A');
    ok('live edit reaches B', await waitFor(() => fragmentText(b.doc).includes('LIVE-EDIT-FROM-A')));

    // onSave persistence: edit shows up in GET /state markdown + revision bump
    const persisted = await waitFor(() => false, 1_500).then(async () => {
      const res = await fetch(`${BASE}/documents/${doc.slug}/state`, {
        headers: { ...AGENT, 'x-share-token': doc.accessToken },
      });
      return (await res.json()) as Record<string, any>;
    });
    ok('persistence: state markdown contains live edit', String(persisted.markdown).includes('LIVE-EDIT-FROM-A'), persisted.markdown);
    ok('persistence: revision bumped', Number(persisted.revision) > 1, persisted.revision);

    // Viewer is read-only: connect to the viewer doc, editor watches
    const vSess = await fetch(`${BASE}/documents/${viewerDoc.slug}/collab-session`, {
      headers: { ...AGENT, 'x-share-token': viewerDoc.accessToken },
    });
    const viewerSession = ((await vSess.json()) as any).session;
    ok('viewer session role is viewer', viewerSession.role === 'viewer');
    const ownerSess = await fetch(`${BASE}/documents/${viewerDoc.slug}/collab-session`, {
      headers: { ...AGENT, 'x-bridge-token': viewerDoc.ownerSecret },
    });
    const ownerSession = ((await ownerSess.json()) as any).session;
    ok('owner session maps to editor', ownerSession.role === 'editor');
    const viewer = connectProvider(viewerDoc.slug, viewerSession.token);
    const watcher = connectProvider(viewerDoc.slug, ownerSession.token);
    cleanups.push(() => viewer.provider.destroy(), () => watcher.provider.destroy());
    ok('viewer synced', await waitSynced(viewer.provider));
    ok('watcher synced', await waitSynced(watcher.provider));
    appendParagraph(viewer.doc, 'VIEWER-WRITE-MUST-NOT-PROPAGATE');
    const leaked = await waitFor(() => fragmentText(watcher.doc).includes('VIEWER-WRITE-MUST-NOT-PROPAGATE'), 2_500);
    ok('viewer write does NOT propagate', !leaked);

    // Forged token is refused
    const rogue = connectProvider(doc.slug, 'forged.token');
    cleanups.push(() => rogue.provider.destroy());
    const rogueSynced = await waitSynced(rogue.provider, 4_000);
    ok('forged token never syncs', !rogueSynced);

    // Refresh mints a working token
    const refresh = await fetch(`${BASE}/documents/${doc.slug}/collab-refresh`, {
      method: 'POST',
      headers: { ...AGENT, 'x-share-token': doc.accessToken },
    });
    ok('collab-refresh -> 200', refresh.status === 200);
    const refreshed = ((await refresh.json()) as any).session;
    const c = connectProvider(doc.slug, refreshed.token);
    cleanups.push(() => c.provider.destroy());
    ok('refreshed token connects + syncs', await waitSynced(c.provider));
    ok('refreshed client sees document', await waitFor(() => fragmentText(c.doc).includes('LIVE-EDIT-FROM-A')));

    console.log(`\nworker-collab-sync: ${passed} assertions passed`);
  } finally {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    proc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
