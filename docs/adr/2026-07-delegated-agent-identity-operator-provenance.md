# Delegated Agent Identity: Operator JWTs Admit Agents, Provenance Declares Them

Status: accepted

Resolves issue #43. The "Copy agent invite link" feature promised that any agent could collaborate via a pasted per-document token, which is structurally false behind Cloudflare Access (the edge blocks everything without Access credentials). Rather than weakening the Zero Trust posture, we add a second admission mode for agents: an agent running on behalf of a human obtains that human's short-lived Access JWT via `cloudflared access login` / `cloudflared access token` and calls the agent bridge with it, declaring itself with an `x-agent-id` request header. The human whose credential admits the agent is its **Operator** (see `CONTEXT.md`). Service tokens remain the admission mode for autonomous agents (CI, automations); nothing about the edge or the per-document authorization layer changes.

## The declaration is provenance, not security

`x-agent-id` is honest self-declaration. When the edge identity is human and the header is present, the resolved identity becomes an Agent with an Operator; the actor is recorded as `ai:<agentId>` (unchanged format) and every actor-attributed artifact — document events, authored provenance marks, comments — gains an additive, optional `operator: "<email>"` field. The security identity is the Operator's either way: a client that omits the header simply acts as the human, so nothing may branch authorization on the declaration. Consequently a delegated Agent holds exactly the role its Operator would hold (instance Default Role plus any presented Document Token), and owner-level operations still require the Owner Secret. When the edge identity is a service token, `x-agent-id` is ignored — the token's `common_name` stays the sole source of agent identity.

## Considered options

- **Embed an Access service token in the invite prompt** — rejected: hands an org-wide edge credential out per document share; unacceptable blast radius.
- **A non-Access hostname or path carve-out for agent routes** — rejected again (reaffirms the access-authn-document-tokens-authz ADR): reopens the public surface.
- **Cap the role of self-declared agents** (e.g. commenter unless a token grants more) — rejected as incoherent: the declaration is voluntary, so a cap restrains only honest agents while dishonest ones inherit the full Default Role. Behavioral expectations belong in the served agent docs, not in role derivation.
- **Encode the Operator in the actor string** (`ai:<id>@<email>`) — rejected: the `ai:`/`human:` prefix convention is parsed by the editor and consumed by event pollers; a structured additive field is the only genuinely additive shape.
- **Restrict the invite feature to service-token agents only** — rejected: requires a Zero Trust admin round-trip per agent, killing the "employee pastes into their own agent" use case the feature exists for.

## Consequences

- The invite feature becomes deployment-aware (an additive `authMode` field on the editor's open-context boot response): Access deployments generate a bootstrap prompt (doc URL + token, cloudflared-first edge auth with service-token fallback, `x-agent-id`, then "GET `/agent-docs` and follow it"); dev mode (`PROOF_DEV_MODE=1`) generates the same shape using `x-dev-identity`, exercising the identical delegated-identity code path.
- `/agent-docs` — advertised in every `_links` block but never actually served by this fork — must become a real, Access-gated route serving fork-audited behavioral docs. Instructions then version with the deploy and cannot drift from the server implementing them (the issue #40/#41 failure class). `docs/agent-docs.md` is upstream-derived and needs an accuracy audit before being served as truth.
- `AGENT_CONTRACT.md` gains additive entries (`x-agent-id` request header, `operator` field on events/marks); `docs/VISION.md`'s agent sentence ("using an Access service token plus per-document tokens") must be updated to include delegated admission; the `proof-docs` skill gains the delegated-auth path and defers to `/agent-docs` for behavior.
- Known accepted loosenesses: (1) a delegated agent can self-declare an id that collides with a service token's `common_name` — distinguishable by the presence of `operator`; (2) the pre-existing `by` payload override (`workers/document-do.ts`) can still relabel some events — tracked as a follow-up, out of scope here; (3) UI actions never send `x-agent-id`, so a human curling the bridge without the header is indistinguishable from a UI edit.
- Access JWTs are short-lived; agents must re-run `cloudflared access token` on 401. Revoking the human's SSO session revokes every agent it admitted.
