/**
 * Access identity resolution tests (workers/access.ts).
 *
 * Signs real JWTs with a locally generated key and verifies resolveIdentity
 * via an injected key getter — covering signature, audience, issuer, expiry,
 * human vs service-token claims, and the dev-mode rules.
 */

import { strict as assert } from 'node:assert';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { resolveIdentity } from '../../workers/access';

const TEAM = 'test-team.cloudflareaccess.com';
const AUD = 'test-aud-tag';

async function main() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const getKey = createLocalJWKSet({ keys: [jwk] });

  const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  async function sign(
    claims: Record<string, unknown>,
    opts: { aud?: string; iss?: string; exp?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setAudience(opts.aud ?? AUD)
      .setIssuer(opts.iss ?? `https://${TEAM}`)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  }

  function req(headers: Record<string, string> = {}): Request {
    return new Request('https://docs.example.com/whoami', { headers });
  }

  // Valid human JWT via header
  {
    const token = await sign({ email: 'jane@example.com' });
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.deepEqual(id, {
      kind: 'human',
      email: 'jane@example.com',
      source: 'access',
    });
    console.log('ok: valid human JWT resolves');
  }

  // Valid human JWT via CF_Authorization cookie
  {
    const token = await sign({ email: 'jane@example.com' });
    const id = await resolveIdentity(
      req({ cookie: `other=1; CF_Authorization=${token}` }),
      accessEnv,
      getKey,
    );
    assert.equal(id?.kind, 'human');
    console.log('ok: cookie JWT resolves');
  }

  // Service token JWT (common_name, no email)
  {
    const token = await sign({ common_name: 'ci-agent.access' });
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.deepEqual(id, {
      kind: 'agent',
      serviceTokenId: 'ci-agent.access',
      source: 'access',
    });
    console.log('ok: service-token JWT resolves as agent');
  }

  // Missing token
  {
    const id = await resolveIdentity(req(), accessEnv, getKey);
    assert.equal(id, null);
    console.log('ok: missing token rejected');
  }

  // Wrong audience
  {
    const token = await sign({ email: 'jane@example.com' }, { aud: 'other-app' });
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.equal(id, null);
    console.log('ok: wrong audience rejected');
  }

  // Wrong issuer
  {
    const token = await sign(
      { email: 'jane@example.com' },
      { iss: 'https://evil.example.com' },
    );
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.equal(id, null);
    console.log('ok: wrong issuer rejected');
  }

  // Expired token
  {
    const token = await new SignJWT({ email: 'jane@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .sign(privateKey);
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.equal(id, null);
    console.log('ok: expired token rejected');
  }

  // Forged token (signed by a different key)
  {
    const rogue = await generateKeyPair('RS256');
    const token = await new SignJWT({ email: 'mallory@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setAudience(AUD)
      .setIssuer(`https://${TEAM}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(rogue.privateKey);
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token }),
      accessEnv,
      getKey,
    );
    assert.equal(id, null);
    console.log('ok: forged signature rejected');
  }

  // Dev mode: only when Access is NOT configured
  {
    const devEnv = { PROOF_DEV_MODE: '1', DEV_IDENTITY: 'dev@example.com' };
    const id = await resolveIdentity(req(), devEnv, getKey);
    assert.deepEqual(id, {
      kind: 'human',
      email: 'dev@example.com',
      source: 'dev',
    });
    console.log('ok: dev identity works without Access config');
  }

  // Dev header override + dev agent
  {
    const devEnv = { PROOF_DEV_MODE: '1' };
    const id = await resolveIdentity(
      req({ 'x-dev-identity': 'someone@example.com' }),
      devEnv,
      getKey,
    );
    assert.equal(id?.kind === 'human' && id.email, 'someone@example.com');
    const agent = await resolveIdentity(
      req({ 'x-dev-agent': 'local-agent' }),
      devEnv,
      getKey,
    );
    assert.equal(agent?.kind === 'agent' && agent.serviceTokenId, 'local-agent');
    console.log('ok: dev header identities work');
  }

  // Dev injection is IGNORED when Access is configured (the invariant)
  {
    const env = { ...accessEnv, PROOF_DEV_MODE: '1', DEV_IDENTITY: 'dev@example.com' };
    const id = await resolveIdentity(
      req({ 'x-dev-identity': 'mallory@example.com' }),
      env,
      getKey,
    );
    assert.equal(id, null);
    console.log('ok: dev injection unreachable when Access is configured');
  }

  // Neither configured: reject
  {
    const id = await resolveIdentity(req(), {}, getKey);
    assert.equal(id, null);
    console.log('ok: unconfigured env rejects everything');
  }

  // Delegated agent: human JWT + x-agent-id annotates the identity
  {
    const token = await sign({ email: 'jane@example.com' });
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token, 'x-agent-id': 'claude-code' }),
      accessEnv,
      getKey,
    );
    assert.deepEqual(id, {
      kind: 'human',
      email: 'jane@example.com',
      source: 'access',
      delegatedAgentId: 'claude-code',
    });
    console.log('ok: human JWT + x-agent-id resolves as delegated agent');
  }

  // x-agent-id is ignored on service-token identities (common_name is
  // the sole source of agent identity)
  {
    const token = await sign({ common_name: 'ci-agent.access' });
    const id = await resolveIdentity(
      req({ 'cf-access-jwt-assertion': token, 'x-agent-id': 'impostor' }),
      accessEnv,
      getKey,
    );
    assert.deepEqual(id, {
      kind: 'agent',
      serviceTokenId: 'ci-agent.access',
      source: 'access',
    });
    console.log('ok: x-agent-id ignored for service-token identities');
  }

  // Invalid agent ids are treated as absent, never rejected
  {
    const token = await sign({ email: 'jane@example.com' });
    for (const bad of ['-leading-dash', 'has spaces', 'a'.repeat(65), '  ', 'ünïcode']) {
      const id = await resolveIdentity(
        req({ 'cf-access-jwt-assertion': token, 'x-agent-id': bad }),
        accessEnv,
        getKey,
      );
      assert.deepEqual(id, {
        kind: 'human',
        email: 'jane@example.com',
        source: 'access',
      });
    }
    console.log('ok: invalid x-agent-id values degrade to plain human');
  }

  // Dev mode: x-dev-identity + x-agent-id exercises the same delegation path
  {
    const devEnv = { PROOF_DEV_MODE: '1' };
    const id = await resolveIdentity(
      req({ 'x-dev-identity': 'someone@example.com', 'x-agent-id': 'local.agent' }),
      devEnv,
      getKey,
    );
    assert.deepEqual(id, {
      kind: 'human',
      email: 'someone@example.com',
      source: 'dev',
      delegatedAgentId: 'local.agent',
    });
    // x-dev-agent still wins as an autonomous agent; x-agent-id ignored
    const agent = await resolveIdentity(
      req({ 'x-dev-agent': 'local-ci', 'x-agent-id': 'ignored' }),
      devEnv,
      getKey,
    );
    assert.deepEqual(agent, {
      kind: 'agent',
      serviceTokenId: 'local-ci',
      source: 'dev',
    });
    console.log('ok: dev-mode delegation mirrors the Access path');
  }

  console.log('\nworker-access-identity: all tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
