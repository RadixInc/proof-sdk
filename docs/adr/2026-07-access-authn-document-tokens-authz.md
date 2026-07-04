# Cloudflare Access Is Authentication; Document Tokens Are Authorization

Status: accepted

The deployment sits entirely behind Cloudflare Zero Trust. Humans authenticate via corporate SSO through Access; the Worker trusts the validated `Cf-Access-Jwt-Assertion` and uses its email claim as the user identity for provenance attribution, comment authorship, and the personal library. Any Access-authenticated human can open any ACTIVE document at its clean URL (`/d/:slug`) and receives a configurable instance-wide default role (initially `editor`); share tokens remain only for granting a role above the default and for pause/revoke semantics. Agents authenticate at the edge with Access service tokens (`CF-Access-Client-Id`/`-Secret` headers), and below that layer the per-document `ownerSecret`/`accessToken` contract from `AGENT_CONTRACT.md` is unchanged — the service token answers "may this client reach the app at all", the document token answers "what may it do to this document".

## Why

Upstream's pure capability model (tokenized links, anonymous-by-token identity) defends against outsiders — but Access already excludes outsiders entirely, and tokens embedded in URLs leak into chat logs while blocking teammates who receive a bare link. Verified SSO identity also gives real-name attribution, which a documentation collaboration tool wants. Keeping document tokens for agents preserves the public agent contract byte-for-byte (the bridge client already supports arbitrary extra headers, so service-token headers are purely additive).

## Considered options

- **Keep the pure capability model** — rejected: clean links would 403 for teammates and comments could not be attributed to people.
- **Full per-user ACLs with invites/groups** — rejected: a significant new subsystem the codebase has no scaffolding for, solving a problem an internal open-by-default tool does not have.
- **A separate non-Access API hostname for agents** — rejected: exposes the API surface to the public internet, contradicting the Zero Trust posture.

## Consequences

- The Worker must verify the Access JWT signature (per-application AUD, Access certs) rather than blindly trusting headers, so a misconfigured DNS bypass cannot forge identity.
- The stubbed upstream OAuth layer (`server/hosted-auth.ts`, `share_auth_sessions`) is deleted, not ported.
- Local development needs an Access-emulation path (dev-only identity injection) since there is no Access in `wrangler dev`.
