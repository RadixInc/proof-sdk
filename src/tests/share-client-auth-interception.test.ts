/**
 * Edge-auth interception detection (expired Access SSO session).
 *
 * The deployment sits behind Cloudflare Access. When a long-lived tab's SSO
 * session expires, Access answers API fetches itself with its login page —
 * the client sees HTTP 200 with an HTML body and the Worker never sees the
 * request. Before detection existed, every mutation from such a tab was a
 * silent no-op: a suggestion accept "returned 200" yet resolved nothing.
 *
 * Verifies: an HTML 200 where JSON is expected reports failure to the caller
 * and raises the auth-interception flag; a later JSON response clears it; a
 * real JSON API error does not raise it.
 */

import assert from 'node:assert/strict';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function accessLoginResponse(): Response {
  return new Response('<!DOCTYPE html><html><body>Sign in to your organization</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://docs.example.com/d/test-doc?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };

  let mode: 'intercepted' | 'ok' | 'api-error' = 'intercepted';

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (mode === 'intercepted') {
      return accessLoginResponse();
    }
    if (mode === 'api-error') {
      return jsonResponse({ success: false, error: 'Forbidden', code: 'forbidden' }, 403);
    }
    if (url.pathname === '/api/agent/test-doc/ops') {
      const bodyText = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(bodyText) as { payload?: { markId?: string } };
      return jsonResponse({ success: true, markId: body.payload?.markId, marks: {} });
    }
    throw new Error(`Unexpected request path in ok mode: ${url.pathname}`);
  };

  try {
    const { shareClient } = await import('../bridge/share-client.js');

    const notifications: boolean[] = [];
    shareClient.onAuthInterception((intercepted) => {
      notifications.push(intercepted);
    });
    assert.deepEqual(notifications, [false], 'subscription should fire immediately with the current state');

    // 1. Access serves its login page with a 200: the mutation must report
    //    failure (not a silent no-op) and raise the interception flag.
    const accept = await shareClient.acceptSuggestion('mark-1', 'human:editor');
    assert.ok(accept && !('error' in accept), 'intercepted accept should not classify as an API error');
    assert.equal(accept.success, false, 'intercepted accept must report failure');
    assert.deepEqual(notifications, [false, true], 'interception should notify subscribers');

    // 2. The collab session refresh path is intercepted the same way.
    const refreshed = await shareClient.refreshCollabSession();
    assert.equal(refreshed, null, 'intercepted collab-refresh should return null');
    assert.deepEqual(notifications, [false, true], 'already-raised flag should not re-notify');

    // 3. A pushUpdate answered by the login page is not a successful push.
    const pushed = await shareClient.pushUpdate('# doc', {}, 'human:editor');
    assert.equal(pushed, false, 'intercepted pushUpdate must report failure');

    // 4. The user re-authenticates (e.g. in another tab): the next JSON
    //    response clears the flag and mutations work again.
    mode = 'ok';
    const acceptAfter = await shareClient.acceptSuggestion('mark-2', 'human:editor');
    assert.ok(acceptAfter && !('error' in acceptAfter) && acceptAfter.success === true, 'accept should succeed after re-auth');
    assert.deepEqual(notifications, [false, true, false], 'recovery should notify subscribers');

    // 5. A genuine JSON API error is not an interception.
    mode = 'api-error';
    const denied = await shareClient.acceptSuggestion('mark-3', 'human:editor');
    assert.ok(denied && 'error' in denied && denied.error.status === 403, 'JSON error should surface as an API error');
    assert.deepEqual(notifications, [false, true, false], 'JSON errors must not raise the interception flag');

    console.log('ok: share-client auth interception (5 scenarios)');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
