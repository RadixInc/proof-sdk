/**
 * Cloudflare Worker entry point.
 *
 * Serves the built editor bundle from static assets, exposes /healthz, and
 * resolves the request identity through Cloudflare Access (see access.ts).
 * Later slices add the API router and the per-document Durable Object.
 */

import { resolveIdentity, unauthorized } from './access';
import type { AccessEnv } from './access';

export interface Env extends AccessEnv {
  /** Static assets binding — the Vite build output in ./dist. */
  ASSETS: Fetcher;
  /** Build identifier injected at deploy time (Workers Builds sets this). */
  PROOF_BUILD_SHA?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health is the one identity-free route (uptime checks, Workers Builds).
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'proof-sdk',
        build: env.PROOF_BUILD_SHA ?? 'dev',
      });
    }

    const identity = await resolveIdentity(request, env);
    if (!identity) {
      return unauthorized(env);
    }

    if (url.pathname === '/whoami') {
      return Response.json({ ok: true, identity });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
