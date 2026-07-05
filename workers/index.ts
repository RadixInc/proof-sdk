/**
 * Cloudflare Worker entry point.
 *
 * Serves the built editor bundle from static assets, exposes /healthz, and
 * resolves the request identity through Cloudflare Access (see access.ts).
 * Later slices add the API router and the per-document Durable Object.
 */

import { getServerByName } from 'partyserver';
import { resolveIdentity, unauthorized } from './access';
import type { AccessEnv } from './access';
import { handleApiRequest } from './api';
import type { ApiEnv } from './api';

export { DocumentDO } from './document-do';

export interface Env extends AccessEnv, ApiEnv {
  /** Static assets binding — the Vite build output in ./dist. */
  ASSETS: Fetcher;
  /** Build identifier injected at deploy time (Workers Builds sets this). */
  PROOF_BUILD_SHA?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health is the one identity-free route (uptime checks, Workers Builds).
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'proof-sdk',
        build: env.PROOF_BUILD_SHA ?? 'dev',
      });
    }

    // Collab WebSocket: hand the upgrade to the document's DO room. This
    // path sits before the edge identity gate deliberately — its credential
    // is the HMAC collab session token (minted via an authenticated,
    // document-token-gated route, verified in the DO at connect, revocable
    // via the access epoch). Browser WebSocket upgrades cannot carry custom
    // headers, so gating them on Access identity would break clients whose
    // cookie is not forwarded while adding no authorization the token does
    // not already prove.
    const collabMatch = url.pathname.match(/^\/documents\/([a-z0-9-]+)\/collab$/);
    if (collabMatch && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const stub = await getServerByName(
        env.DOCUMENT_DO as unknown as Parameters<typeof getServerByName>[0],
        collabMatch[1],
      );
      return stub.fetch(request);
    }

    const identity = await resolveIdentity(request, env);
    if (!identity) {
      return unauthorized(env);
    }

    if (url.pathname === '/whoami') {
      return Response.json({ ok: true, identity });
    }

    const apiResponse = await handleApiRequest(request, env, identity, ctx);
    if (apiResponse) return apiResponse;

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
