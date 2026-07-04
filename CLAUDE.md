# Agent Instructions

## This repo is PUBLIC — never commit anything organization-specific

This codebase is a deployment-agnostic core (see `docs/adr/2026-07-deployment-agnostic-public-core.md`). Any organization must be able to deploy it privately on Cloudflare. Binding rules for all commits, docs, issues, and PRs:

- **NEVER commit secrets or credentials**: API keys, service tokens, signing secrets, `.dev.vars`, real `wrangler` config with account/resource IDs.
- **NEVER commit organization-identifying values**: internal hostnames, Access team domains or AUD tags, Cloudflare account IDs, D1/R2/KV/DO namespace IDs, employee names or emails, internal URLs or channel names — in code, config, docs, tests, fixtures, comments, or issue/PR text.
- **Use neutral placeholders** in docs and examples: `your-org`, `docs.example.com`, `<ACCESS_TEAM_DOMAIN>`.
- **Config boundary**: commit `wrangler.example.jsonc` with placeholders; real config is supplied via Workers Builds variables/secrets or gitignored local files. If a value differs between deploying organizations, it is configuration, not code.
- If something sensitive is committed by mistake, stop and say so immediately — do not attempt a quiet fixup; history rewrites need a human decision.

## Project context

- `docs/VISION.md` — purpose, security model, anti-goals. Read before starting any task; do not implement anything that contradicts the Security Model.
- `docs/adr/` — accepted decisions (runtime, sync layer, auth model, fork posture). Respect them; flag conflicts instead of silently deviating.
- `CONTEXT.md` — the project glossary. Use its terms in code and docs; avoid the terms it marks as _Avoid_.
- `AGENT_CONTRACT.md` — the public agent HTTP contract. It is frozen: changes must be backward-compatible and additive.
- `packages/doc-core` and `packages/doc-editor` stay upstream-cherry-pickable: avoid local modifications unless unavoidable.
