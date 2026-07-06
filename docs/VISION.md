# Vision

## Purpose

A self-hosted, coding-agent-friendly documentation collaboration tool: humans and agents co-author markdown documents with comments, suggestions, rewrites, and provenance tracking. This is a hard fork of the open-source Proof SDK, re-platformed to run natively on Cloudflare, designed to be deployed by any organization behind its own Cloudflare Zero Trust configuration with corporate SSO, serving geographically distributed users (e.g., US and Europe).

## What "done" looks like

- A single Cloudflare Worker (plus Durable Objects) serves the editor, API, and realtime collaboration; no Node servers, no containers.
- Any SSO-authenticated human opens `/d/:slug` and collaborates in real time, attributed by their corporate identity.
- Any authorized agent (laptop, CI, cloud) drives documents through the unchanged public agent HTTP contract (`AGENT_CONTRACT.md`), admitted at the edge either by an Access service token (autonomous agents) or by its Operator's delegated Access JWT via cloudflared (agents run by a person in the org), plus per-document tokens. (ADR: delegated-agent-identity-operator-provenance)
- Deploys happen via Cloudflare Workers Builds from `main` (production) and non-production branches (preview/staging); GitHub Actions runs tests only.

## Architecture (decided — see docs/adr/)

- **Runtime**: Workers + one Durable Object per document slug (single serialized writer; owns Y.Doc, WebSockets via hibernation, DO SQLite persistence, event queue, idempotency, rate limits, alarms). D1 = global document index + library. R2 = HTML share snapshots. (ADR: cloudflare-workers-do-per-document-runtime)
- **Sync layer**: y-partyserver / YProvider replaces Hocuspocus. (ADR: y-partyserver-for-yjs-sync)
- **Auth**: Cloudflare Access is authentication (humans via SSO JWT, agents via service tokens); per-document tokens remain authorization. SSO humans get an instance-wide default role (`editor`) on ACTIVE documents. (ADR: access-authn-document-tokens-authz)
- **Fork posture**: hard fork; `AGENT_CONTRACT.md` and `packages/doc-core`/`doc-editor` stay upstream-stable. (ADR: hard-fork-with-stable-agent-contract)
- **Placement**: automatic DO placement, no jurisdiction pinning (no data-residency requirement identified). Cross-region collaborators tolerate presence-level latency.

## Security model

- **No public surface.** Every hostname is behind Cloudflare Access; nothing is reachable without SSO (humans) or a service token (agents).
- The Worker verifies the Access JWT (signature, AUD, issuer) on every request — headers are never trusted bare, so a DNS/origin bypass cannot forge identity.
- Per-document tokens (`ownerSecret`, document tokens) remain the authorization layer beneath Access; secrets are stored hashed, compared timing-safe.
- Agent capability is bounded by document role; owner-level operations require the owner secret.
- A delegated agent's self-declaration (`x-agent-id`) is provenance, never a security boundary: the authenticated identity is its Operator's, so authorization never branches on the declaration.
- No telemetry leaves the deployment; the bug-report bridge posts only to a deployer-configured GitHub repository.
- The repo is public and deployment-agnostic: no organization-specific values (hostnames, IDs, team domains, secrets) are ever committed — see docs/adr/2026-07-deployment-agnostic-public-core.md and CLAUDE.md.

## Anti-goals

- Not a SaaS: no public signup, no OAuth, no multi-tenant hosting, no billing.
- No merge-compatibility with upstream's Node server; upstream tracking is limited to cherry-picks in `doc-core`/`doc-editor`.
- No OG/social preview cards: link unfurlers cannot pass Access, so the images have no consumers (this is why `share-preview.ts` is deleted, not ported).
- No per-user ACL/invite system; open-by-default within the SSO perimeter is the product stance.

## Open questions

- Per-PR preview deployments with isolated stateful resources (DO/D1) — deferred until the platform is stable.
- Data-residency pinning (`jurisdiction: "eu"`) — revisit only if a compliance requirement materializes; would require rethinking the D1 global index.
- Whether the instance-wide default role should be `editor` or `commenter` once real usage patterns emerge.
