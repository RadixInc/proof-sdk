import assert from 'node:assert/strict';

type FetchRecord = {
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  const requests: FetchRecord[] = [];

  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://proof-web-staging.up.railway.app/d/test-doc?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, headers, body });

    if (url.pathname === '/api/agent/test-doc/ops') {
      return jsonResponse({ success: true, markId: (body?.payload as Record<string, unknown> | undefined)?.markId, marks: {} });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  try {
    const { shareClient } = await import('../bridge/share-client.js');

    const accept = await shareClient.acceptSuggestion('mark-accept', 'human:editor');
    assert.equal((accept && 'error' in accept) ? false : accept?.success, true, 'acceptSuggestion should succeed');

    const reject = await shareClient.rejectSuggestion('mark-reject', 'human:editor');
    assert.equal((reject && 'error' in reject) ? false : reject?.success, true, 'rejectSuggestion should succeed');

    const resolve = await shareClient.resolveComment('mark-resolve', 'human:editor');
    assert.equal((resolve && 'error' in resolve) ? false : resolve?.success, true, 'resolveComment should succeed');

    const unresolve = await shareClient.unresolveComment('mark-unresolve', 'human:editor');
    assert.equal((unresolve && 'error' in unresolve) ? false : unresolve?.success, true, 'unresolveComment should succeed');

    // All four mutations route through the ops envelope (AGENT_CONTRACT.md)
    // rather than a dedicated REST route — there is no server-side handler
    // for /agent/:slug/marks/* paths.
    const opsRequests = requests.filter((request) => request.path === '/api/agent/test-doc/ops');
    assert.equal(opsRequests.length, 4, 'all four mutations should submit through /ops');

    const acceptRequest = opsRequests.find((request) => (request.body?.payload as Record<string, unknown> | undefined)?.markId === 'mark-accept');
    assert.equal(acceptRequest?.body?.type, 'suggestion.accept', 'acceptSuggestion should submit a suggestion.accept op');

    const rejectRequest = opsRequests.find((request) => (request.body?.payload as Record<string, unknown> | undefined)?.markId === 'mark-reject');
    assert.equal(rejectRequest?.body?.type, 'suggestion.reject', 'rejectSuggestion should submit a suggestion.reject op');

    const resolveRequest = opsRequests.find((request) => (request.body?.payload as Record<string, unknown> | undefined)?.markId === 'mark-resolve');
    assert.equal(resolveRequest?.body?.type, 'comment.resolve', 'resolveComment should submit a comment.resolve op');

    const unresolveRequest = opsRequests.find((request) => (request.body?.payload as Record<string, unknown> | undefined)?.markId === 'mark-unresolve');
    assert.equal(unresolveRequest?.body?.type, 'comment.unresolve', 'unresolveComment should submit a comment.unresolve op');

    console.log('share-client-mark-preconditions.test.ts passed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
