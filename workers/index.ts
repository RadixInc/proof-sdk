/**
 * Cloudflare Worker entry point.
 *
 * Walking skeleton (issue #2): serves the built editor bundle from static
 * assets and exposes a health endpoint. Later slices add the API router,
 * Access identity, and the per-document Durable Object.
 */

export interface Env {
  /** Static assets binding — the Vite build output in ./dist. */
  ASSETS: Fetcher;
  /** Build identifier injected at deploy time (Workers Builds sets this). */
  PROOF_BUILD_SHA?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true,
        service: 'proof-sdk',
        build: env.PROOF_BUILD_SHA ?? 'dev',
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
