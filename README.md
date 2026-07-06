# Proof SDK

Proof SDK is an open-source collaborative markdown editor with provenance tracking and an agent HTTP bridge, running natively on Cloudflare Workers. Humans and coding agents collaborate on the same documents in real time: humans through the editor behind your SSO, agents through a stable HTTP contract.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to). This fork is deployment-agnostic: any organization can deploy its own private instance on Cloudflare (see `docs/adr/2026-07-deployment-agnostic-public-core.md`).

## Architecture

- **Cloudflare Worker** — routing, Access-verified identity, the agent HTTP API, static editor assets
- **One Durable Object per document** — the single serialized writer: live Yjs collaboration (y-partyserver), durable CRDT persistence (update log + snapshots + compaction in DO SQLite), agent ops, idempotency, the event log
- **D1** — the global document index, per-user library, visit tracking
- **R2** — read-only HTML share snapshots
- **Cloudflare Access** — authentication for humans (SSO) and agents (service tokens); document tokens remain authorization (see `docs/adr/2026-07-access-authn-document-tokens-authz.md`)

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, accept/reject, and rewrite operations via `POST /documents/:slug/ops`
- Agent event stream (`events/pending` / `events/ack`)
- Share lifecycle: default SSO roles, above-default access links, pause/resume/revoke
- Per-user library keyed by SSO identity
- The agent client SDK under `packages/agent-bridge` and an example app under `apps/proof-example`

## Workspace Layout

- `workers/` — the Cloudflare Worker + document Durable Object
- `src/` — the web editor (Vite build served as Worker static assets)
- `packages/doc-core`, `packages/doc-editor` — upstream-cherry-pickable editor internals
- `packages/agent-bridge` — the agent HTTP client SDK
- `migrations/` — D1 migrations
- `docs/` — vision, ADRs, agent docs, provenance spec

## Local Development

Requirements: Node.js 22+.

```bash
npm install
npm run build        # build the editor bundle into dist/
npm run cf:init      # materialize wrangler.jsonc from wrangler.example.jsonc (gitignored)
npm run dev:worker   # wrangler dev on http://localhost:8787 (simulates DO/D1/R2 locally)
```

Copy `.dev.vars.example` to `.dev.vars` for local identity injection (`PROOF_DEV_MODE=1`). `npm run dev` starts Vite for editor development, proxying API routes to `wrangler dev`.

Local tests boot the Worker under `wrangler dev`:

```bash
npm test                      # unit + identity suites
npm run test:conformance      # AGENT_CONTRACT.md as an executable gate
npm run test:collab-sync      # live Yjs clients against the DO room
npm run test:durability       # cold-start replay, compaction, projection health
# plus: test:human-identity, test:agent-ops, test:share-lifecycle,
#       test:r2-snapshots, test:library
```

## Deploying on Cloudflare

Deployment is handled by [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connected to your fork: production deploys from `main`, every non-production branch produces a preview build. GitHub Actions runs tests only — it never deploys.

One-time setup:

1. Create resources: `wrangler d1 create proof-sdk` and `wrangler r2 bucket create proof-sdk-snapshots`
2. Connect the repo to Workers Builds; set the build variables consumed by `scripts/cf-init.mjs` (`D1_DATABASE_ID`, optionally `WORKER_NAME`)
3. Deploy command: `npx wrangler d1 migrations apply proof-sdk --remote && npx wrangler deploy --var PROOF_BUILD_SHA:$WORKERS_CI_COMMIT_SHA`
4. Put the Worker behind a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) application on your custom domain and set the runtime variables below

Runtime configuration (dashboard variables/secrets — never committed):

| Variable | Purpose |
| --- | --- |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Verify Access JWTs (required in production) |
| `PROOF_COLLAB_SIGNING_SECRET` (secret) | HMAC signing for collab session tokens |
| `PROOF_PUBLIC_BASE_URL` | Absolute URLs in API responses |
| `PROOF_DEFAULT_HUMAN_ROLE` | Role for tokenless SSO humans (default `editor`) |
| `PROOF_GITHUB_ISSUES_OWNER` / `_REPO` / `_TOKEN` (secret) | Bug-report bridge target repository (optional) |
| `PROOF_COLLAB_PERSIST_DEBOUNCE_MS`, `PROOF_YJS_SNAPSHOT_EVERY_UPDATES`, `PROOF_OPS_RATE_LIMIT_MAX`, `PROOF_OPS_RATE_LIMIT_WINDOW_MS`, `PROOF_EVENT_RETENTION_MAX`, `PROOF_SNAPSHOT_PREFIX` | Tuning (defaults documented in `wrangler.example.jsonc`) |

This repo is public and deployment-agnostic: real config (account IDs, hostnames, Access domains, secrets) lives in gitignored files or dashboard variables, never in the repo. See `CLAUDE.md` for the binding rules.

## Core Routes

- `POST /documents`, `POST /share/markdown` — create
- `GET /documents/:slug/state`, `GET /documents/:slug` — read
- `POST /documents/:slug/ops` — comments, suggestions, accept/reject, rewrites (send `Idempotency-Key`)
- `GET /documents/:slug/events/pending`, `POST /documents/:slug/events/ack` — agent event stream
- `GET /documents/:slug/collab-session`, WS `/documents/:slug/collab` — realtime collaboration
- `POST /documents/:slug/{pause,resume,revoke,delete}`, `POST /documents/:slug/access-links` — owner lifecycle
- `GET /snapshots/:slug.html` — read-only share snapshot
- `GET /library` — per-user library

The full agent surface is specified in `AGENT_CONTRACT.md` (frozen; changes are additive only) and pinned by `npm run test:conformance`.

## Docs

- `AGENT_CONTRACT.md` — the public agent HTTP contract
- `docs/VISION.md` — purpose, security model, anti-goals
- `docs/adr/` — accepted architecture decisions
- `workers/agent-docs.ts`, `workers/proof-skill.ts` — agent usage guides, served by the deployment at `/agent-docs` and `/proof.SKILL.md`
- `docs/PROVENANCE-SPEC-v2.md` — provenance model

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
