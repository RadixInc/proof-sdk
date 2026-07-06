/**
 * Delegated agent identity end-to-end (issue #43).
 *
 * Boots the Worker in dev mode and drives the ops route under the three
 * actor shapes the ADR defines
 * (docs/adr/2026-07-delegated-agent-identity-operator-provenance.md):
 *   - delegated agent (human identity + x-agent-id): actor is ai:<agentId>,
 *     Operator recorded on events and marks
 *   - plain human (no x-agent-id): actor is human:<email>, no operator
 *   - autonomous agent (service-token identity): x-agent-id is ignored
 * Also asserts the actor-string formats are unchanged and the operator
 * field is absent (not null) when there is no delegation.
 */

import { applyLocalMigrations, finish, startWorker } from './worker-harness';

const PORT = 8989;
const BASE = `http://127.0.0.1:${PORT}`;
const CREATOR = { 'x-dev-agent': 'creator-bot', 'content-type': 'application/json' };
const OPERATOR_EMAIL = 'operator@example.com';

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

async function postOp(
  slug: string,
  token: string,
  identityHeaders: Record<string, string>,
  body: unknown,
) {
  const res = await fetch(`${BASE}/documents/${slug}/ops`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-share-token': token,
      ...identityHeaders,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  try {
    const createRes = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: CREATOR,
      body: JSON.stringify({
        markdown:
          '# Delegation\n\nThe quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
        title: 'Delegation',
      }),
    });
    const doc = (await createRes.json()) as Record<string, any>;
    ok('setup: document created', createRes.status === 200 && !!doc.slug, doc);
    const slug = doc.slug as string;
    const token = doc.accessToken as string;

    // 1. Delegated agent: human identity + x-agent-id.
    const delegated = await postOp(
      slug,
      token,
      { 'x-dev-identity': OPERATOR_EMAIL, 'x-agent-id': 'claude-code' },
      { type: 'comment.add', payload: { text: 'From a delegated agent', quote: 'quick brown fox' } },
    );
    ok('delegated comment.add -> 200', delegated.status === 200, delegated.body);
    const delegatedMarkId = delegated.body.markId as string;
    const delegatedMark = delegated.body.marks?.[delegatedMarkId] as Record<string, any>;
    ok('delegated mark by is ai:<agentId>', delegatedMark?.by === 'ai:claude-code', delegatedMark);
    ok('delegated mark records operator', delegatedMark?.operator === OPERATOR_EMAIL, delegatedMark);

    // 2. Plain human: same operator email, no x-agent-id.
    const human = await postOp(
      slug,
      token,
      { 'x-dev-identity': OPERATOR_EMAIL },
      { type: 'comment.add', payload: { text: 'Directly from a human', quote: 'lazy dog' } },
    );
    ok('human comment.add -> 200', human.status === 200, human.body);
    const humanMarkId = human.body.markId as string;
    const humanMark = human.body.marks?.[humanMarkId] as Record<string, any>;
    ok('human mark by is human:<email>', humanMark?.by === `human:${OPERATOR_EMAIL}`, humanMark);
    ok('human mark has no operator key', !('operator' in (humanMark ?? {})), humanMark);

    // 3. Autonomous agent: service-token-style identity; x-agent-id ignored.
    const autonomous = await postOp(
      slug,
      token,
      { 'x-dev-agent': 'ci-bot', 'x-agent-id': 'impostor' },
      { type: 'comment.add', payload: { text: 'From an autonomous agent', quote: 'five dozen' } },
    );
    ok('autonomous comment.add -> 200', autonomous.status === 200, autonomous.body);
    const autonomousMarkId = autonomous.body.markId as string;
    const autonomousMark = autonomous.body.marks?.[autonomousMarkId] as Record<string, any>;
    ok('autonomous mark by is ai:<serviceTokenId>', autonomousMark?.by === 'ai:ci-bot', autonomousMark);
    ok('autonomous mark has no operator key', !('operator' in (autonomousMark ?? {})), autonomousMark);

    // Delegated suggestion + reply also carry the operator.
    const suggestion = await postOp(
      slug,
      token,
      { 'x-dev-identity': OPERATOR_EMAIL, 'x-agent-id': 'claude-code' },
      {
        type: 'suggestion.add',
        payload: { kind: 'replace', quote: 'liquor jugs', content: 'juice jugs' },
      },
    );
    ok('delegated suggestion.add -> 200', suggestion.status === 200, suggestion.body);
    const suggestionMark = suggestion.body.marks?.[suggestion.body.markId as string] as Record<string, any>;
    ok('delegated suggestion records operator', suggestionMark?.operator === OPERATOR_EMAIL, suggestionMark);

    const reply = await postOp(
      slug,
      token,
      { 'x-dev-identity': OPERATOR_EMAIL, 'x-agent-id': 'claude-code' },
      { type: 'comment.reply', payload: { markId: humanMarkId, text: 'Agent replying' } },
    );
    ok('delegated comment.reply -> 200', reply.status === 200, reply.body);
    const repliedMark = reply.body.mark as Record<string, any>;
    const lastReply = repliedMark?.thread?.[repliedMark.thread.length - 1] as Record<string, any>;
    ok('delegated reply by is ai:<agentId>', lastReply?.by === 'ai:claude-code', repliedMark);
    ok('delegated reply records operator', lastReply?.operator === OPERATOR_EMAIL, repliedMark);

    // Events expose actor + operator (operator only where delegated).
    const eventsRes = await fetch(
      `${BASE}/documents/${slug}/events/pending?after=0&limit=50`,
      { headers: { 'x-dev-agent': 'creator-bot', 'x-share-token': token } },
    );
    const events = ((await eventsRes.json()) as any).events as Array<Record<string, any>>;
    ok('events fetched', eventsRes.status === 200 && Array.isArray(events), events);
    const delegatedEvent = events.find(
      (e) => e.type === 'comment.added' && e.data?.markId === delegatedMarkId,
    );
    ok('delegated event actor is ai:<agentId>', delegatedEvent?.actor === 'ai:claude-code', delegatedEvent);
    ok('delegated event records operator', delegatedEvent?.operator === OPERATOR_EMAIL, delegatedEvent);
    const humanEvent = events.find(
      (e) => e.type === 'comment.added' && e.data?.markId === humanMarkId,
    );
    ok('human event actor is human:<email>', humanEvent?.actor === `human:${OPERATOR_EMAIL}`, humanEvent);
    ok('human event has no operator key', !!humanEvent && !('operator' in humanEvent), humanEvent);
    const autonomousEvent = events.find(
      (e) => e.type === 'comment.added' && e.data?.markId === autonomousMarkId,
    );
    ok('autonomous event actor is ai:<serviceTokenId>', autonomousEvent?.actor === 'ai:ci-bot', autonomousEvent);
    ok('autonomous event has no operator key', !!autonomousEvent && !('operator' in autonomousEvent), autonomousEvent);

    // Presence announced by a delegated agent records the Operator and can
    // default its id from the verified identity (empty body).
    const delegatedPresence = await fetch(`${BASE}/documents/${slug}/presence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-share-token': token,
        'x-dev-identity': OPERATOR_EMAIL,
        'x-agent-id': 'claude-code',
      },
      body: JSON.stringify({}),
    });
    const delegatedPresenceBody = (await delegatedPresence.json()) as Record<string, any>;
    ok('delegated presence -> 200', delegatedPresence.status === 200, delegatedPresenceBody);
    ok(
      'delegated presence id defaults from identity',
      delegatedPresenceBody.presence?.id === 'ai:claude-code',
      delegatedPresenceBody,
    );
    ok(
      'delegated presence records operator',
      delegatedPresenceBody.presence?.operator === OPERATOR_EMAIL,
      delegatedPresenceBody,
    );

    // Editor boot response declares the deployment's edge-auth story.
    const openRes = await fetch(`${BASE}/documents/${slug}/open-context`, {
      headers: { 'x-dev-identity': OPERATOR_EMAIL, 'x-share-token': token },
    });
    const openBody = (await openRes.json()) as Record<string, any>;
    ok('open-context reports authMode dev', openBody.authMode === 'dev', openBody.authMode);

    // /agent-docs is a real, identity-gated route serving markdown.
    const docsRes = await fetch(`${BASE}/agent-docs`, {
      headers: { 'x-dev-identity': OPERATOR_EMAIL },
    });
    const docsText = await docsRes.text();
    ok(
      'agent-docs served as markdown',
      docsRes.status === 200 &&
        (docsRes.headers.get('content-type') ?? '').includes('text/markdown') &&
        docsText.includes('x-agent-id'),
      docsRes.status,
    );
    // (No unauthenticated 401 assertion here: the route sits behind the
    // same resolveIdentity gate as every API route — structural in
    // workers/index.ts — and dev-mode DEV_IDENTITY in the harness's
    // wrangler.jsonc would satisfy it anyway.)

    console.log(`\nworker-delegated-identity: all ${passed} assertions passed`);
  } finally {
    worker.stop();
  }
  finish(0);
}

main().catch((err) => {
  console.error(err);
  finish(1);
});
