/**
 * Contract conformance suite for the Workers implementation (issue #6).
 *
 * Boots the Worker under `wrangler dev` and asserts the public agent
 * contract (AGENT_CONTRACT.md) against it. This is the CI gate that makes
 * the hard-fork ADR's promise — the agent contract stays stable — an
 * executable fact rather than an aspiration.
 *
 * Assertions are drawn from src/tests/server-routes-and-share.test.ts (the
 * upstream conformance bar) for every surface the Workers stack implements.
 * Surfaces not yet ported are listed in SKIPPED_SURFACES with the issue
 * that will land them; when one lands, move its assertions up here.
 */

import { applyLocalMigrations, finish, startWorker } from './worker-harness';
import type { WorkerHandle } from './worker-harness';

const SKIPPED_SURFACES: Array<{ surface: string; reason: string }> = [
  { surface: 'POST /documents/:slug/ops (+ bridge comment/suggestion routes)', reason: 'lands with issue #10/#11' },
  { surface: 'GET /documents/:slug/events/pending + POST events/ack', reason: 'lands with issue #12' },
  { surface: 'POST /documents/:slug/presence', reason: 'lands with issue #7 (collab)' },
  { surface: 'PUT /documents/:slug, PUT /documents/:slug/title', reason: 'lands with issue #10/#11' },
  { surface: '/d/:slug web routes + content negotiation', reason: 'lands with issue #9' },
  { surface: 'direct-share per-IP rate limiting (429 + Retry-After)', reason: 'DO-based limiter, issue #11' },
  { surface: 'OG card rendering', reason: 'deleted by design — see VISION.md anti-goals' },
];

let passed = 0;

function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

type Server = WorkerHandle;

const AGENT = { 'x-dev-agent': 'conformance-agent' };
const JSON_HDRS = { ...AGENT, 'content-type': 'application/json' };

async function baseBattery(s: Server) {
  // --- POST /documents: canonical create (upstream test L556, L610, L626)
  const createRes = await fetch(`${s.base}/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({
      markdown: '# Hello\n\nConformance body.',
      title: 'Conformance',
      ownerId: 'agent:conformance',
      marks: {},
    }),
  });
  ok('POST /documents -> 200', createRes.status === 200);
  const doc = (await createRes.json()) as Record<string, any>;
  ok('create: success true', doc.success === true);
  ok('create: slug non-empty', typeof doc.slug === 'string' && doc.slug.length > 0);
  ok('create: ownerSecret non-empty', typeof doc.ownerSecret === 'string' && doc.ownerSecret.length > 0);
  ok('create: accessToken non-empty', typeof doc.accessToken === 'string' && doc.accessToken.length > 0);
  ok('create: url starts /d/', String(doc.url).startsWith('/d/'));
  ok('create: shareUrl contains /d/', String(doc.shareUrl).includes('/d/'));
  ok('create: _links.view is string', typeof doc._links.view === 'string');
  ok('create: _links.edit.href contains /documents/', String(doc._links.edit.href).includes('/documents/'));
  ok('create: _links.presence.href contains /documents/', String(doc._links.presence.href).includes('/documents/'));
  ok('create: agent.createApi contains /documents', String(doc.agent.createApi).includes('/documents'));
  ok('create: agent.bridgeApi.comments contains /documents/', String(doc.agent.bridgeApi.comments).includes('/documents/'));
  ok('create: accessRole editor', doc.accessRole === 'editor');
  ok('create: shareState ACTIVE + active', doc.shareState === 'ACTIVE' && doc.active === true);

  // --- GET state with x-share-token (upstream L634)
  const stateRes = await fetch(`${s.base}/documents/${doc.slug}/state`, {
    headers: { ...AGENT, 'x-share-token': doc.accessToken },
  });
  ok('GET state -> 200', stateRes.status === 200);
  const state = (await stateRes.json()) as Record<string, any>;
  ok('state: markdown contains # Hello', String(state.markdown).includes('# Hello'));
  ok('state: _links.state contains path', String(state._links.state).includes(`/documents/${doc.slug}/state`));

  // --- state auth failures
  const noTok = await fetch(`${s.base}/documents/${doc.slug}/state`, { headers: AGENT });
  ok('state without token -> 401 UNAUTHORIZED', noTok.status === 401 && ((await noTok.json()) as any).code === 'UNAUTHORIZED');
  const ownerRead = await fetch(`${s.base}/documents/${doc.slug}/state`, {
    headers: { ...AGENT, 'x-bridge-token': doc.ownerSecret },
  });
  ok('state with ownerSecret -> 200', ownerRead.status === 200);
  const missing = await fetch(`${s.base}/documents/zzzzzzzz/state`, { headers: AGENT });
  ok('state unknown slug -> 404', missing.status === 404);

  // --- lenient read after create (upstream L1669 tail)
  const lenient = await fetch(`${s.base}/api/documents/${doc.slug}`, { headers: AGENT });
  ok('GET /api/documents/:slug -> 200', lenient.status === 200);
  const lenientBody = (await lenient.json()) as Record<string, any>;
  ok('lenient read: markdown + shareState', String(lenientBody.markdown).includes('Conformance body') && lenientBody.shareState === 'ACTIVE');

  // --- POST /share/markdown JSON (upstream L545, L1669)
  const shareRes = await fetch(`${s.base}/share/markdown`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Shared\n\nvia direct share', role: 'editor' }),
  });
  ok('POST /share/markdown -> 200', shareRes.status === 200);
  const share = (await shareRes.json()) as Record<string, any>;
  ok('share: shareUrl contains /d/', String(share.shareUrl).includes('/d/'));
  ok('share: accessRole editor', share.accessRole === 'editor');
  ok('share: _links.state + ops + events', String(share._links.state).includes('/state') && String(share._links.ops.href).includes('/ops') && String(share._links.events).includes('/events/pending'));

  // --- raw markdown mode with query params (upstream L1694)
  const rawRes = await fetch(`${s.base}/share/markdown?title=Raw%20Doc`, {
    method: 'POST',
    headers: { ...AGENT, 'content-type': 'text/markdown' },
    body: '# Raw\n\nraw body',
  });
  ok('share raw markdown -> 200', rawRes.status === 200);
  const raw = (await rawRes.json()) as Record<string, any>;
  ok('share raw: default role editor', raw.accessRole === 'editor');
  ok('share raw: shareUrl contains /d/', String(raw.shareUrl).includes('/d/'));

  // --- validation errors (upstream L1050-1074, L1708)
  const badMarks = await fetch(`${s.base}/documents`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ markdown: '# x', marks: [1] }) });
  ok('non-object marks -> 400', badMarks.status === 400);
  const noMd = await fetch(`${s.base}/documents`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({}) });
  const noMdBody = (await noMd.json()) as any;
  ok('missing markdown -> 400 MISSING_MARKDOWN + fix', noMd.status === 400 && noMdBody.code === 'MISSING_MARKDOWN' && String(noMdBody.fix).includes('markdown'));
  const blank = await fetch(`${s.base}/documents`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ markdown: '   ' }) });
  const blankBody = (await blank.json()) as any;
  ok('blank markdown -> 400 EMPTY_MARKDOWN', blank.status === 400 && blankBody.code === 'EMPTY_MARKDOWN' && blankBody.error === 'markdown must not be empty');
  const aliasNoMd = await fetch(`${s.base}/api/share/markdown`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({}) });
  ok('/api/share/markdown missing markdown -> 400 MISSING_MARKDOWN', aliasNoMd.status === 400 && ((await aliasNoMd.json()) as any).code === 'MISSING_MARKDOWN');
  const badRole = await fetch(`${s.base}/share/markdown`, { method: 'POST', headers: JSON_HDRS, body: JSON.stringify({ markdown: '# x', role: 'owner_bot' }) });
  ok('invalid role -> 400 exact error', badRole.status === 400 && ((await badRole.json()) as any).error === 'role must be viewer, commenter, or editor');
}

async function warnAndApiKeyBattery(s: Server) {
  // --- legacy warn mode (upstream L570)
  const res = await fetch(`${s.base}/api/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Legacy' }),
  });
  ok('legacy warn -> 200', res.status === 200);
  ok('legacy warn: deprecation header', res.headers.get('deprecation') === 'true');
  ok('legacy warn: x-proof-legacy-create header', res.headers.get('x-proof-legacy-create') === 'warn');
  const body = (await res.json()) as Record<string, any>;
  ok('legacy warn: body deprecation.mode', body.deprecation?.mode === 'warn');
  ok('legacy warn: canonicalPath /documents', body.deprecation?.canonicalPath === '/documents');

  // canonical path must NOT carry deprecation in warn mode
  const canonical = await fetch(`${s.base}/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Canonical' }),
  });
  ok('canonical path: no deprecation header', canonical.status === 200 && canonical.headers.get('deprecation') === null);

  // --- api_key auth mode (upstream L1718, L1774)
  const unauth = await fetch(`${s.base}/share/markdown`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# x' }),
  });
  ok('api_key mode unauth -> 401 UNAUTHORIZED', unauth.status === 401 && ((await unauth.json()) as any).code === 'UNAUTHORIZED');
  const authed = await fetch(`${s.base}/share/markdown`, {
    method: 'POST',
    headers: { ...JSON_HDRS, authorization: 'Bearer test-direct-share-key' },
    body: JSON.stringify({ markdown: '# x', role: 'viewer' }),
  });
  ok('api_key mode with bearer -> 200', authed.status === 200);
  const authedBody = (await authed.json()) as Record<string, any>;
  ok('api_key: success + accessRole viewer', authedBody.success === true && authedBody.accessRole === 'viewer');
}

async function disabledBattery(s: Server) {
  // --- legacy disabled mode (upstream L590)
  const res = await fetch(`${s.base}/api/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Legacy' }),
  });
  ok('legacy disabled -> 410', res.status === 410);
  ok('legacy disabled: header', res.headers.get('x-proof-legacy-create') === 'disabled');
  const body = (await res.json()) as Record<string, any>;
  ok('legacy disabled: code', body.code === 'LEGACY_CREATE_DISABLED');
  ok('legacy disabled: fix', body.fix === 'Use POST /documents');
  ok('legacy disabled: docs', body.docs === '/agent-docs');

  // canonical path still works
  const canonical = await fetch(`${s.base}/documents`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Canonical still works' }),
  });
  ok('canonical unaffected by disabled legacy mode', canonical.status === 200);
}

async function main() {
  await applyLocalMigrations();

  const devVars = { PROOF_DEV_MODE: '1' };

  console.log('\n--- config 1: base (dev mode) ---');
  let server = await startWorker(8971, devVars);
  try {
    await baseBattery(server);
  } finally {
    server.stop();
  }

  console.log('\n--- config 2: legacy warn + api_key auth ---');
  server = await startWorker(8972, {
    ...devVars,
    PROOF_LEGACY_CREATE_MODE: 'warn',
    PROOF_SHARE_MARKDOWN_AUTH_MODE: 'api_key',
    PROOF_SHARE_MARKDOWN_API_KEY: 'test-direct-share-key',
  });
  try {
    await warnAndApiKeyBattery(server);
  } finally {
    server.stop();
  }

  console.log('\n--- config 3: legacy disabled ---');
  server = await startWorker(8973, { ...devVars, PROOF_LEGACY_CREATE_MODE: 'disabled' });
  try {
    await disabledBattery(server);
  } finally {
    server.stop();
  }

  console.log(`\nworker-conformance: ${passed} assertions passed`);
  console.log('\nskipped surfaces (not yet ported):');
  for (const s of SKIPPED_SURFACES) console.log(`  - ${s.surface} — ${s.reason}`);
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
