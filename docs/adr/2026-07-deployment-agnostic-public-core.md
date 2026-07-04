# Deployment-Agnostic Public Core; Organization Config Is Never Committed

Status: accepted

This repository is public. The code, documentation, issue text, and examples must not identify, or bind the implementation to, any particular deploying organization: any outside organization should be able to take this codebase and stand up their own private Cloudflare deployment. Everything organization-specific — hostnames, Cloudflare account and resource IDs, Access team domain and application AUD tags, service-token identifiers, the bug-report target repository, the instance default role — is runtime configuration supplied outside version control (Workers Builds variables/secrets or a gitignored local config; the repo commits only an example config with placeholder values). Documentation and examples use neutral placeholders (`your-org`, `docs.example.com`).

## Why

Git history is permanent: a committed secret or internal hostname in a public repo is disclosed forever, even after removal. Beyond leakage, hardcoded org values silently turn a reusable core into a single-tenant fork — the same failure the upstream project's hosted/SDK split exists to prevent, one level down.

## Consequences

- Repo-root `CLAUDE.md` carries binding agent instructions (agents load it every session; ADRs they may never read).
- CI runs secret and organization-identifier leak scanning as a merge gate.
- Real deployment config lives in the Cloudflare dashboard / secrets store, never in the repo — including for CI and preview builds.
- Public GitHub issues and PRs are held to the same standard as code: no internal hostnames, IDs, or employee identifiers.
