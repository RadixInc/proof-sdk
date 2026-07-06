/**
 * Installable agent skill, served at GET /proof.SKILL.md (issue #44).
 *
 * A person installs this once into their agent's skills directory (e.g.
 * ~/.claude/skills/proof-collab/SKILL.md) and the one-shot invite paste
 * becomes a durable capability. The audience is agents *outside* a clone
 * of this repo, so the file must be fully self-contained: no repo paths,
 * no org-specific values. The deployment origin is interpolated at serve
 * time from the request — deployment-agnostic code, deployment-specific
 * output — so nothing organization-identifying is ever committed
 * (CLAUDE.md).
 *
 * Behavioral truth lives in /agent-docs (versioned with the deploy); this
 * skill teaches auth and defers there for everything else, the same
 * anti-drift posture as the invite prompt.
 */

export function buildProofSkillMarkdown(origin: string): string {
  return `---
name: proof-collab
description: Collaborate on shared Proof documents via their HTTP contract — read a document, add comments and suggestions, apply edits, poll for changes, and announce presence. Trigger on any Proof document URL (a /d/<slug> link, usually with a ?token= query param) or when asked to review, comment on, or edit a Proof doc.
---

# proof-collab

Proof documents are collaborative markdown documents served by a
deployment like ${origin}. Humans edit in a browser; you work through the
HTTP contract. This file covers getting in; the deployment itself serves
the canonical API reference — endpoints, op shapes, etiquette — at
\`GET <origin>/agent-docs\`. **Read that first on every new document**;
it versions with the server, so prefer it over anything you remember.

The file you are reading was served by ${origin}; if a document URL
points at a different origin, use that origin throughout instead.

## Auth — two layers on every request

**1. Edge (Cloudflare Access).** Non-local deployments are unreachable
without an edge credential:

- **Delegated (default when you work for a person):** mint their
  short-lived Access JWT with cloudflared, then send it as a
  \`cf-access-token\` header:

      cloudflared access login <origin>     # one-time browser SSO hop
      cloudflared access token --app=<origin>

  On a 401, the token expired — mint it again. If cloudflared is missing
  or login fails, tell the user; do not try to work around the edge.
- **Service token (autonomous/CI):** send \`CF-Access-Client-Id\` /
  \`CF-Access-Client-Secret\` headers, provisioned by the deployment's
  Zero Trust admin (often available to you as \`PROOF_ACCESS_CLIENT_ID\` /
  \`PROOF_ACCESS_CLIENT_SECRET\`).

Local dev deployments (localhost) skip this layer.

**2. Document token.** The \`?token=\` value in the document URL, sent as
an \`x-share-token\` header. It scopes what you may do to that document.
Treat tokens as secrets: never echo them into chat output.

## Declare yourself

Send \`x-agent-id: <a-short-stable-id>\` (e.g. \`claude-code\`) on every
request. When you enter with a person's delegated credential, this
attributes your actions to you as the acting agent with that person
recorded as the operator — without it, your edits are indistinguishable
from theirs.

## Working a document

1. \`GET <origin>/agent-docs\` — the endpoint and op reference; read it first.
2. \`GET <origin>/documents/<slug>/state\` — read before you write.
3. Announce yourself: \`POST <origin>/documents/<slug>/presence\` with
   \`{"agentId": "<your-id>", "name": "<display name>", "status": "active"}\`;
   re-announce periodically (viewers hide entries older than ~60s) and
   \`POST .../presence/disconnect\` when done.
4. Prefer comments and suggestions over direct rewrites unless explicitly
   asked to rewrite; use an \`Idempotency-Key\` header on mutations.
5. Reply to whoever invited you with a brief summary of what you changed.
`;
}

export function proofSkillResponse(origin: string): Response {
  return new Response(buildProofSkillMarkdown(origin), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
