import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpError,
  buildHeaders,
  chooseCredential,
  explainFailure,
  parseDocRef,
  redact,
  slugFromPath,
} from './proof-docs.mjs';

test('slugFromPath reads the slug from agent-contract paths', () => {
  assert.equal(slugFromPath('/documents/abc123xy/state'), 'abc123xy');
  assert.equal(slugFromPath('/documents/abc123xy'), 'abc123xy');
  assert.equal(slugFromPath('/api/agent/abc123xy/ops?x=1'), 'abc123xy');
  assert.equal(slugFromPath('/agent-docs'), undefined);
  assert.equal(slugFromPath('/documents/../etc/passwd'), undefined);
});

test('parseDocRef accepts a bare slug or a document URL', () => {
  assert.deepEqual(parseDocRef('abc123xy', 'https://h.example'), { host: 'https://h.example', slug: 'abc123xy' });
  assert.deepEqual(parseDocRef('https://docs.example.test/d/abc123xy?token=t0k', 'https://other.example'), {
    host: 'https://docs.example.test',
    slug: 'abc123xy',
    token: 't0k',
  });
  assert.throws(() => parseDocRef('https://docs.example.test/nope'), /slug/);
  assert.throws(() => parseDocRef('../x', 'https://h.example'), /Invalid slug/);
});

test('redact masks a token wherever it appears, including share links', () => {
  const accessToken = 'aaaaaaaa-0000-4000-8000-fixturetoken1';
  const out = JSON.stringify(
    redact({
      accessToken,
      ownerSecret: 'bbbbbbbb-0000-4000-8000-fixtureowner1',
      tokenPath: `/d/abc123xy?token=${accessToken}`,
      tokenUrl: `https://docs.example.test/d/abc123xy?token=${accessToken}`,
      nested: { link: `see ${accessToken} here` },
    })
  );
  assert.ok(!out.includes(accessToken), out);
  assert.ok(!out.includes('bbbbbbbb-0000'), out);
  assert.match(out, /token=<redacted>/);
});

test('chooseCredential prefers --token, then URL token, and explains a missing credential', () => {
  const explicit = chooseCredential({ host: 'https://h.example', slug: 'abc123xy', explicitToken: 'a', urlToken: 'b' });
  assert.equal(explicit.token, 'a');
  const fromUrl = chooseCredential({ host: 'https://h.example', slug: 'abc123xy', urlToken: 'b' });
  assert.equal(fromUrl.token, 'b');
  const none = chooseCredential({ host: 'https://h.example', slug: 'zz-no-such-doc-zz', strict: false });
  assert.equal(none.token, undefined);
  assert.match(none.source, /^none/);
  assert.throws(
    () => chooseCredential({ host: 'https://h.example', slug: 'zz-no-such-doc-zz', strict: true }),
    /secrets list/
  );
});

test('explainFailure names the missing credential on a document 401', () => {
  const err = new HttpError(401, 'Unauthorized', { success: false, code: 'UNAUTHORIZED' });
  assert.match(explainFailure(err, { source: 'none (no slug)', host: 'https://h.example' }), /no document credential was sent/);
  assert.match(explainFailure(err, { source: 'stored accessToken for "x"', host: 'https://h.example' }), /rejected the credential/);
  const edge = new HttpError(401, 'Unauthorized', '<html>Access</html>');
  assert.match(explainFailure(edge, { source: 'x', host: 'https://h.example' }), /cloudflared access login/);
  assert.equal(explainFailure(new HttpError(500, 'x', {}), { source: 'x', host: 'h' }), '');
});

test('a document token is not replaced by the creation API key', () => {
  const headers = buildHeaders(
    { host: 'http://localhost:4000', apiKey: 'creation-key', agentId: 'claude-code' },
    { Authorization: 'Bearer doc-token' }
  );
  assert.equal(headers.Authorization, 'Bearer doc-token');
  const keyOnly = buildHeaders({ host: 'http://localhost:4000', apiKey: 'creation-key' }, {});
  assert.equal(keyOnly.Authorization, 'Bearer creation-key');
});
