/**
 * Client metrics ingest (POST /api/metrics/:name).
 *
 * The web editor fires fire-and-forget telemetry beacons for mark-anchor
 * resolution results and collab reconnect durations. Before this route
 * existed, those POSTs fell through to the static-asset handler and 405ed
 * on every page load. Verifies: both known metrics ingest with 204 for
 * humans and agents, unknown names 404 instead of falling through to
 * assets, malformed/oversized payloads are rejected, and the route stays
 * behind the identity gate (401 without an identity).
 */

import { applyLocalMigrations, finish, startWorker } from './worker-harness';

const PORT = 8991;
const BASE = `http://127.0.0.1:${PORT}`;
const HUMAN = { 'x-dev-identity': 'pat.example@example.com', 'content-type': 'application/json' };
const AGENT = { 'x-dev-agent': 'metrics-test', 'content-type': 'application/json' };

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

function post(path: string, headers: Record<string, string>, body: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body });
}

async function main() {
  await applyLocalMigrations();
  const worker = await startWorker(PORT, { PROOF_DEV_MODE: '1' });
  try {
    const anchor = await post(
      '/api/metrics/mark-anchor',
      HUMAN,
      JSON.stringify({ result: 'failure', source: 'web' }),
    );
    ok('mark-anchor (human) -> 204', anchor.status === 204);

    const anchorAgent = await post(
      '/api/metrics/mark-anchor',
      AGENT,
      JSON.stringify({ result: 'success', source: 'bridge' }),
    );
    ok('mark-anchor (agent) -> 204', anchorAgent.status === 204);

    const reconnect = await post(
      '/api/metrics/collab-reconnect',
      HUMAN,
      JSON.stringify({ durationMs: 843.7, source: 'web' }),
    );
    ok('collab-reconnect -> 204', reconnect.status === 204);

    // No source field: still accepted (the handler defaults it).
    const noSource = await post(
      '/api/metrics/collab-reconnect',
      HUMAN,
      JSON.stringify({ durationMs: 12 }),
    );
    ok('collab-reconnect without source -> 204', noSource.status === 204);

    const unknown = await post(
      '/api/metrics/nonexistent',
      HUMAN,
      JSON.stringify({ result: 'success' }),
    );
    ok('unknown metric -> 404 (not asset-handler 405)', unknown.status === 404);

    const badResult = await post(
      '/api/metrics/mark-anchor',
      HUMAN,
      JSON.stringify({ result: 'bogus', source: 'web' }),
    );
    ok('mark-anchor with invalid result -> 400', badResult.status === 400);

    const badDuration = await post(
      '/api/metrics/collab-reconnect',
      HUMAN,
      JSON.stringify({ durationMs: 'fast' }),
    );
    ok('collab-reconnect with non-numeric duration -> 400', badDuration.status === 400);

    const notJson = await post('/api/metrics/mark-anchor', HUMAN, 'result=failure');
    ok('non-JSON body -> 400', notJson.status === 400);

    const notObject = await post('/api/metrics/mark-anchor', HUMAN, JSON.stringify(['failure']));
    ok('JSON array body -> 400', notObject.status === 400);

    const oversized = await post(
      '/api/metrics/mark-anchor',
      HUMAN,
      JSON.stringify({ result: 'failure', source: 'x'.repeat(4096) }),
    );
    ok('oversized payload -> 413', oversized.status === 413);

    const anonymous = await fetch(`${BASE}/api/metrics/mark-anchor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'failure', source: 'web' }),
    });
    ok('no identity -> 401 (route stays behind the gate)', anonymous.status === 401);

    console.log(`\nworker-metrics: ${passed} assertions passed`);
  } finally {
    worker.stop();
  }
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
