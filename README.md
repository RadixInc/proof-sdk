# Proof SDK

Proof SDK is the open-source editor, collaboration server, provenance model, and agent HTTP bridge that power collaborative documents in Proof.

If you want the hosted product, use [Proof](https://proofeditor.ai). Hosted Proof is made by [Every](https://every.to).

## What Is Included

- Collaborative markdown editor with provenance tracking
- Comments, suggestions, and rewrite operations
- Realtime collaboration server
- Agent HTTP bridge for state, marks, edits, presence, and events
- A small example app under `apps/proof-example`

## Workspace Layout

- `packages/doc-core`
- `packages/doc-editor`
- `packages/doc-server`
- `packages/doc-store-sqlite`
- `packages/agent-bridge`
- `apps/proof-example`
- `server`
- `src`

## Local Development

Requirements:

- Node.js 18+

Install dependencies:

```bash
npm install
```

Start the editor:

```bash
npm run dev
```

Start the local server:

```bash
npm run serve
```

The default setup serves the editor on `http://localhost:3000` and the API/server on `http://localhost:4000`.

## Core Routes

Canonical Proof SDK routes:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/edit`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

Compatibility aliases remain mounted for the hosted product, but the routes above are the public SDK surface.

## Deploy on Cloudflare

This fork runs natively on Cloudflare Workers (see `docs/VISION.md` and `docs/adr/`). Deployment is handled by [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connected to your fork: production deploys from `main`, and every non-production branch produces a preview build. GitHub Actions runs tests only.

Local setup:

```bash
npm install
npm run build        # build the editor bundle into dist/
npm run cf:init      # copy wrangler.example.jsonc -> wrangler.jsonc (gitignored)
npm run dev:worker   # serve via wrangler dev
```

This repo is deployment-agnostic and public: your real `wrangler.jsonc`, account IDs, hostnames, Access team domain, and secrets are never committed. Fill them in locally or as Workers Builds variables/secrets. See `CLAUDE.md` and `docs/adr/2026-07-deployment-agnostic-public-core.md`.

## Build

```bash
npm run build
```

The build outputs the web bundle to `dist/` and writes `dist/web-artifact-manifest.json`.

## Tests

```bash
npm test
```

## Docs

- `AGENT_CONTRACT.md`
- `docs/agent-docs.md`
- `docs/proof.SKILL.md`
- `docs/adr/2026-03-proof-sdk-public-core.md`

## License

- Code: `MIT` in `LICENSE`
- Trademark guidance: `TRADEMARKS.md`
