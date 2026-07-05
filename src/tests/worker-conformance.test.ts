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
  { surface: 'POST /documents/:slug/presence', reason: 'lands with issue #7 (collab)' },
  { surface: 'direct-share (create) per-IP rate limiting', reason: 'needs a cross-document limiter; ops mutation rate limiting shipped in #11' },
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

  // --- POST /documents/:slug/ops — agent mark ops (issue #10)
  const opsUrl = `${s.base}/documents/${doc.slug}/ops`;
  const opHeaders = { ...JSON_HDRS, 'x-share-token': doc.accessToken };
  const commentBody = JSON.stringify({
    type: 'comment.add',
    payload: { by: 'ai:conformance', text: 'Looks good', quote: 'Conformance body' },
  });
  const commentRes = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-comment-1' },
    body: commentBody,
  });
  ok('ops comment.add -> 200', commentRes.status === 200, commentRes.status);
  const comment = (await commentRes.json()) as Record<string, any>;
  ok('ops comment.add: markId + eventId', typeof comment.markId === 'string' && Number.isFinite(comment.eventId));
  ok('ops comment.add: mark stored with quote', comment.marks?.[comment.markId]?.kind === 'comment' && String(comment.marks[comment.markId].quote).includes('Conformance body'), comment.marks);

  const replayRes = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-comment-1' },
    body: commentBody,
  });
  const replay = (await replayRes.json()) as Record<string, any>;
  ok('ops idempotent replay -> same markId, no double-apply', replayRes.status === 200 && replay.markId === comment.markId && Object.keys(replay.marks).length === Object.keys(comment.marks).length, replay);

  const reusedRes = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-comment-1' },
    body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:x', text: 'different', quote: 'Conformance body' } }),
  });
  ok('ops idempotency key reuse with new body -> 409 IDEMPOTENCY_KEY_REUSED', reusedRes.status === 409 && ((await reusedRes.json()) as any).code === 'IDEMPOTENCY_KEY_REUSED');

  const replyRes = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'comment.reply', payload: { markId: comment.markId, by: 'ai:conformance', text: 'follow-up' } }),
  });
  const reply = (await replyRes.json()) as Record<string, any>;
  ok('ops comment.reply -> 200 + thread grows', replyRes.status === 200 && Array.isArray(reply.marks[comment.markId].thread) && reply.marks[comment.markId].thread.length === 1, reply.marks?.[comment.markId]);

  const resolveRes = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'comment.resolve', payload: { markId: comment.markId } }),
  });
  const resolveBody = (await resolveRes.json()) as Record<string, any>;
  ok('ops comment.resolve -> 200 + resolved flag', resolveRes.status === 200 && resolveBody.marks[comment.markId].resolved === true);

  const suggestRes = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({
      type: 'suggestion.add',
      payload: { kind: 'replace', by: 'ai:conformance', quote: 'Conformance body', content: 'Improved body' },
    }),
  });
  const suggest = (await suggestRes.json()) as Record<string, any>;
  ok('ops suggestion.add -> 200 pending mark', suggestRes.status === 200 && suggest.marks[suggest.markId].status === 'pending' && suggest.marks[suggest.markId].content === 'Improved body', suggest.marks?.[suggest.markId]);

  const badAnchor = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:x', text: 'hm', quote: 'text that is definitely not present' } }),
  });
  const badAnchorBody = (await badAnchor.json()) as Record<string, any>;
  ok('ops unresolvable anchor -> 409 ANCHOR_NOT_FOUND + nextSteps', badAnchor.status === 409 && badAnchorBody.code === 'ANCHOR_NOT_FOUND' && Array.isArray(badAnchorBody.nextSteps));

  const noType = await fetch(opsUrl, { method: 'POST', headers: opHeaders, body: JSON.stringify({ payload: {} }) });
  ok('ops missing type -> 400', noType.status === 400 && String(((await noType.json()) as any).error).includes('Missing operation type'));

  const noTokOps = await fetch(opsUrl, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:x', text: 'x', quote: 'Conformance body' } }),
  });
  ok('ops without token -> 401', noTokOps.status === 401);

  const agentAlias = await fetch(`${s.base}/api/agent/${doc.slug}/ops`, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:alias', text: 'via alias', quote: 'Conformance body' } }),
  });
  ok('POST /api/agent/:slug/ops alias -> 200', agentAlias.status === 200);

  // --- write ops (issue #11): accept, reject, rewrite, PUT routes
  const acceptRes = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-accept-1' },
    body: JSON.stringify({ type: 'suggestion.accept', payload: { markId: suggest.markId } }),
  });
  const accept = (await acceptRes.json()) as Record<string, any>;
  ok('ops suggestion.accept -> 200 + text applied', acceptRes.status === 200 && String(accept.markdown).includes('Improved body') && !String(accept.markdown).includes('Conformance body'), accept.markdown);
  ok('ops accept: mark status accepted', accept.marks[suggest.markId].status === 'accepted');
  const acceptReplay = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-accept-1' },
    body: JSON.stringify({ type: 'suggestion.accept', payload: { markId: suggest.markId } }),
  });
  const acceptReplayBody = (await acceptReplay.json()) as Record<string, any>;
  ok('ops accept idempotent replay -> no double-apply', acceptReplay.status === 200 && (String(acceptReplayBody.markdown).match(/Improved body/g) ?? []).length === 1, acceptReplayBody.markdown);
  const acceptAgain = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'suggestion.accept', payload: { markId: suggest.markId } }),
  });
  const acceptAgainBody = (await acceptAgain.json()) as Record<string, any>;
  ok('ops accept of finalized mark -> 200 alreadyFinalized', acceptAgain.status === 200 && acceptAgainBody.alreadyFinalized === true);

  const rejSuggest = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'suggestion.add', payload: { kind: 'delete', by: 'ai:conformance', quote: 'Improved body' } }),
  });
  const rejSuggestBody = (await rejSuggest.json()) as Record<string, any>;
  const rejectRes = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'suggestion.reject', payload: { markId: rejSuggestBody.markId } }),
  });
  const reject = (await rejectRes.json()) as Record<string, any>;
  ok('ops suggestion.reject -> 200, markdown unchanged', rejectRes.status === 200 && String(reject.markdown).includes('Improved body') && reject.marks[rejSuggestBody.markId].status === 'rejected');

  const staleRewrite = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'rewrite.apply', payload: { changes: [{ find: 'Improved', replace: 'Refined' }], baseRevision: 1 } }),
  });
  ok('ops rewrite stale base -> 409 STALE_BASE + latestRevision', staleRewrite.status === 409 && (await staleRewrite.json() as any).code === 'STALE_BASE');
  const noBaseRewrite = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'rewrite.apply', payload: { changes: [{ find: 'x', replace: 'y' }] } }),
  });
  ok('ops rewrite without base -> 400', noBaseRewrite.status === 400);

  const stateForBase = await fetch(`${s.base}/documents/${doc.slug}/state`, {
    headers: { ...AGENT, 'x-share-token': doc.accessToken },
  });
  const baseRevision = Number(((await stateForBase.json()) as any).revision);
  const rewriteRes = await fetch(opsUrl, {
    method: 'POST',
    headers: { ...opHeaders, 'idempotency-key': 'conf-rewrite-1' },
    body: JSON.stringify({ type: 'rewrite.apply', payload: { by: 'ai:rewriter', changes: [{ find: 'Improved body', replace: 'Rewritten body' }], baseRevision } }),
  });
  const rewrite = (await rewriteRes.json()) as Record<string, any>;
  ok('ops rewrite.apply changes -> 200 + applied', rewriteRes.status === 200 && String(rewrite.markdown).includes('Rewritten body'), rewrite);
  ok('ops rewrite records agent provenance', Object.values(rewrite.marks as Record<string, any>).some((m) => m.kind === 'authored' && m.by === 'ai:rewriter'), rewrite.marks);
  const missRewrite = await fetch(opsUrl, {
    method: 'POST',
    headers: opHeaders,
    body: JSON.stringify({ type: 'rewrite.apply', payload: { changes: [{ find: 'not-in-doc-at-all', replace: 'x' }], baseRevision: Number(rewrite.revision) } }),
  });
  ok('ops rewrite change target miss -> 409', missRewrite.status === 409 && ((await missRewrite.json()) as any).code === 'CHANGE_TARGET_NOT_FOUND');

  const putTitle = await fetch(`${s.base}/documents/${doc.slug}/title`, {
    method: 'PUT',
    headers: opHeaders,
    body: JSON.stringify({ title: 'Renamed by agent' }),
  });
  ok('PUT /documents/:slug/title -> 200', putTitle.status === 200 && ((await putTitle.json()) as any).title === 'Renamed by agent');
  const putDoc = await fetch(`${s.base}/documents/${doc.slug}`, {
    method: 'PUT',
    headers: opHeaders,
    body: JSON.stringify({ markdown: '# Replaced\n\nFull PUT body.' }),
  });
  const putDocBody = (await putDoc.json()) as Record<string, any>;
  ok('PUT /documents/:slug -> 200 + content replaced', putDoc.status === 200 && String(putDocBody.markdown).includes('Full PUT body'), putDocBody);
  const putNoTok = await fetch(`${s.base}/documents/${doc.slug}`, {
    method: 'PUT',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Nope' }),
  });
  ok('PUT without token -> 401', putNoTok.status === 401);

  const viewerShare = await fetch(`${s.base}/share/markdown`, {
    method: 'POST',
    headers: JSON_HDRS,
    body: JSON.stringify({ markdown: '# Viewer\n\nviewer body', role: 'viewer' }),
  });
  const viewerShareDoc = (await viewerShare.json()) as Record<string, any>;
  const viewerOp = await fetch(`${s.base}/documents/${viewerShareDoc.slug}/ops`, {
    method: 'POST',
    headers: { ...JSON_HDRS, 'x-share-token': viewerShareDoc.accessToken },
    body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:x', text: 'nope', quote: 'viewer body' } }),
  });
  ok('ops with viewer role -> 403 insufficient role', viewerOp.status === 403);

  // --- agent event stream (issue #12)
  const evHeaders = { ...AGENT, 'x-share-token': doc.accessToken };
  const pendingRes = await fetch(`${s.base}/documents/${doc.slug}/events/pending?after=0`, { headers: evHeaders });
  ok('events/pending -> 200', pendingRes.status === 200);
  const pending = (await pendingRes.json()) as Record<string, any>;
  ok('events: ops activity present with stable ids', Array.isArray(pending.events) && pending.events.some((e: any) => e.type === 'comment.added') && pending.events.some((e: any) => e.type === 'document.rewritten'), pending.events?.map((e: any) => e.type));
  const ids = pending.events.map((e: any) => Number(e.id));
  ok('events: ids strictly increasing', ids.every((id: number, i: number) => i === 0 || id > ids[i - 1]));
  ok('events: cursor is last id', Number(pending.cursor) === ids[ids.length - 1]);

  const pageRes = await fetch(`${s.base}/documents/${doc.slug}/events/pending?after=0&limit=1`, { headers: evHeaders });
  const page = (await pageRes.json()) as Record<string, any>;
  ok('events: limit=1 pages one event', page.events.length === 1 && Number(page.cursor) === Number(page.events[0].id));
  const nextPageRes = await fetch(`${s.base}/documents/${doc.slug}/events/pending?after=${page.cursor}&limit=1`, { headers: evHeaders });
  const nextPage = (await nextPageRes.json()) as Record<string, any>;
  ok('events: cursor pagination advances', nextPage.events.length === 1 && Number(nextPage.events[0].id) > Number(page.events[0].id));

  const ackRes = await fetch(`${s.base}/documents/${doc.slug}/events/ack`, {
    method: 'POST',
    headers: { ...evHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ upToId: Number(pending.cursor), by: 'agent:conformance' }),
  });
  const ack = (await ackRes.json()) as Record<string, any>;
  ok('events/ack -> 200 + count', ackRes.status === 200 && Number(ack.acked) === ids.length, ack);
  const afterAck = await fetch(`${s.base}/documents/${doc.slug}/events/pending?after=${pending.cursor}`, { headers: evHeaders });
  const afterAckBody = (await afterAck.json()) as Record<string, any>;
  ok('events: poll past cursor is empty', afterAckBody.events.length === 0 && Number(afterAckBody.cursor) === Number(pending.cursor));
  const ackedVisible = await fetch(`${s.base}/documents/${doc.slug}/events/pending?after=0&limit=1`, { headers: evHeaders });
  const ackedVisibleBody = (await ackedVisible.json()) as Record<string, any>;
  ok('events: ack is advisory (ackedAt/ackedBy recorded)', ackedVisibleBody.events[0].ackedAt !== null && ackedVisibleBody.events[0].ackedBy === 'agent:conformance');

  const agentAliasEvents = await fetch(`${s.base}/api/agent/${doc.slug}/events/pending?after=0`, { headers: evHeaders });
  ok('GET /api/agent/:slug/events/pending alias -> 200', agentAliasEvents.status === 200);
  const noTokEvents = await fetch(`${s.base}/documents/${doc.slug}/events/pending`, { headers: AGENT });
  ok('events without token -> 401', noTokEvents.status === 401);
  const viewerAck = await fetch(`${s.base}/documents/${viewerShareDoc.slug}/events/ack`, {
    method: 'POST',
    headers: { ...JSON_HDRS, 'x-share-token': viewerShareDoc.accessToken },
    body: JSON.stringify({ upToId: 1 }),
  });
  ok('events/ack with viewer role -> 403', viewerAck.status === 403);
  const badAck = await fetch(`${s.base}/documents/${doc.slug}/events/ack`, {
    method: 'POST',
    headers: { ...evHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ upToId: -3 }),
  });
  ok('events/ack invalid upToId -> 400', badAck.status === 400);

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

  // --- per-document ops rate limiting (issue #11; this config sets max=3)
  const rlHeaders = { ...JSON_HDRS, 'x-share-token': body.accessToken };
  let limited: Response | null = null;
  for (let i = 0; i < 5 && !limited; i += 1) {
    const attempt = await fetch(`${s.base}/documents/${body.slug}/ops`, {
      method: 'POST',
      headers: rlHeaders,
      body: JSON.stringify({ type: 'comment.add', payload: { by: 'ai:rl', text: `c${i}`, quote: 'Legacy' } }),
    });
    if (attempt.status === 429) limited = attempt;
  }
  ok('ops rate limit -> 429 within window', limited !== null);
  const limitedBody = (await limited!.json()) as Record<string, any>;
  ok('ops rate limit: RATE_LIMITED + Retry-After', limitedBody.code === 'RATE_LIMITED' && Number(limited!.headers.get('retry-after')) >= 1 && limitedBody.limit?.maxRequests === 3);

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
    PROOF_OPS_RATE_LIMIT_MAX: '3',
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
