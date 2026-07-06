/**
 * Canonical agent behavioral docs, served at GET /agent-docs.
 *
 * This is the single source of truth for how agents should interact with
 * a deployment — it versions with the deploy, so instructions cannot
 * drift from the server implementing them (issue #43; the drift class
 * behind issues #40/#41). The invite prompt the editor generates is a
 * bootstrap that points here; keep this document accurate against the
 * router in api.ts and the op registry in ops.ts whenever routes change.
 *
 * Everything here must stay deployment-agnostic: no real hostnames,
 * team domains, or credentials (CLAUDE.md).
 */

export const AGENT_DOCS_MARKDOWN = `# Proof Agent Docs

You are reading the canonical instructions for collaborating on documents
in this Proof deployment through its HTTP contract. If you fetched this
after being invited to a document, read it fully before acting.

## Authentication — two layers, always

**1. Edge (Cloudflare Access).** Every non-local deployment sits behind
Cloudflare Access; nothing is reachable without it. Two ways in:

- **Service token** (autonomous agents: CI, automations): send
  \`CF-Access-Client-Id\` and \`CF-Access-Client-Secret\` headers on every
  request, provisioned by the deployment's Zero Trust admin.
- **Delegated (an agent working on a person's behalf):** obtain that
  person's short-lived Access JWT via cloudflared:

      cloudflared access login <origin>
      cloudflared access token --app=<origin>

  Send the token as a \`cf-access-token\` header on every request. On a
  401, the token has expired — run \`cloudflared access token\` again.

**2. Document (authorization).** What you may do to a specific document:

- \`x-share-token: <accessToken>\` — the per-document token from a share
  link (\`?token=...\` in the document URL) grants its role (viewer,
  commenter, or editor).
- \`x-bridge-token: <ownerSecret>\` — owner-level credential, required for
  pause/resume/revoke/delete. Only the document's creator holds it.

Also accepted for either token: \`Authorization: Bearer <token>\` or a
\`?token=\` query parameter (prefer headers — URLs leak into logs).

## Declare yourself: x-agent-id

If you are an agent using a person's delegated credential, send
\`x-agent-id: <your-id>\` on every request — a short stable identifier
(letters, digits, dots, dashes, underscores; max 64 chars, e.g.
\`claude-code\`). Your actions are then attributed to you as the acting
agent, with the person recorded as the operator on whose behalf you act.
This is honest self-declaration for provenance; it never changes what you
are allowed to do. It is ignored when you authenticate with a service
token (the token's name already identifies you).

## Expectations

- **Read before you write.** Fetch \`GET /documents/:slug/state\` and
  understand the current markdown and marks before making changes.
- **Prefer suggestions and comments over direct rewrites.** Suggestions
  let humans accept or reject your changes; \`rewrite.apply\` replaces
  content outright and should be reserved for when you were explicitly
  asked to rewrite.
- **Poll and ack events** if you are collaborating over time, so you see
  comments and decisions from others: \`GET events/pending\`, then
  \`POST events/ack\` for what you have processed.
- **Summarize what you did** back to whoever invited you: which comments
  or suggestions you added, and where.
- **Use an Idempotency-Key header** on ops you might retry.

## Endpoints

Document-scoped paths also work with the \`/api/agent/:slug/...\` alias
where noted. All bodies are JSON.

- \`POST /documents\` — create a document.
  Body: \`{"markdown": "# ...", "title": "...", "role": "editor"}\`
  (role sets the share link's grant: viewer | commenter | editor).
  Returns \`slug\`, \`shareUrl\`, \`tokenUrl\`, \`accessToken\`, \`ownerSecret\`.
  Store the secrets securely; never display them.
- \`GET /documents/:slug/state\` (alias \`/api/agent/:slug/state\`) — full
  document state: markdown, marks, revision, share state.
- \`POST /documents/:slug/ops\` (alias \`/api/agent/:slug/ops\`) — apply an
  op (see the op reference below).
- \`POST /documents/:slug/presence\` (alias \`/api/agent/:slug/presence\`) —
  announce yourself to people in the live editor. Body:
  \`{"agentId": "<your-id>", "name": "<display name>", "status": "active"}\`
  (agentId may be omitted; it defaults from your identity). Viewers hide
  entries older than ~60s, so re-announce periodically while you work.
  \`POST .../presence/disconnect\` with \`{"agentId": "<your-id>"}\` when
  you finish.
- \`GET /documents/:slug/events/pending?after=<cursor>&limit=<n>\` (alias
  \`/api/agent/:slug/events/pending\`) — poll the durable event queue.
  Each event has \`id\`, \`type\`, \`data\`, \`actor\`, and — when the action
  was performed by a delegated agent — \`operator\`.
- \`POST /documents/:slug/events/ack\` — body \`{"upToId": <cursor>}\`;
  requires editor or owner.
- \`PUT /documents/:slug/title\` — body \`{"title": "..."}\` (editor+).
- \`GET /documents/:slug\` — document read (REST shape).
- \`PUT /documents/:slug\` — replace markdown (editor+); supports
  \`baseRevision\` for optimistic concurrency.
- \`POST /documents/:slug/pause|resume|revoke|delete\` — owner lifecycle
  (requires \`x-bridge-token\`).
- \`POST /documents/:slug/access-links\` — mint an additional share token
  (owner).
- \`GET /snapshots/:slug.html\` — read-only HTML share snapshot, when
  configured.

## Op reference (POST .../ops)

Envelope: \`{"type": "<op>", "payload": {...}}\`. Anchored ops locate text
by \`quote\` (an exact substring of the current markdown).

- \`comment.add\` — \`{"text": "...", "quote": "..."}\`
- \`comment.reply\` — \`{"markId": "...", "text": "..."}\`
- \`comment.resolve\` / \`comment.unresolve\` — \`{"markId": "..."}\`
- \`suggestion.add\` — \`{"kind": "insert" | "delete" | "replace",
  "quote": "...", "content": "..."}\` (content required unless delete)
- \`suggestion.accept\` / \`suggestion.reject\` — \`{"markId": "..."}\`
- \`rewrite.apply\` — either \`{"content": "<full new markdown>",
  "baseRevision": <n>}\` or \`{"changes": [{"find": "...",
  "replace": "..."}], "baseRevision": <n>}\`. On 409 \`STALE_BASE\`,
  re-fetch state and rebuild against the latest revision. Partial
  \`changes\` mode preserves provenance; full \`content\` mode resets it.

## Errors you should handle

- **401 at the edge** — missing/expired Access credential. Delegated:
  re-run \`cloudflared access token\`. Service token: check the headers.
- **401/403 at the document** — missing or insufficient document token;
  ask the person who invited you for a link with the right role.
- **409 STALE_BASE** — the document moved; re-read state and retry.
- **409 IDEMPOTENCY_KEY_REUSED** — same key, different body; mint a new
  key.
`;

export function agentDocsResponse(): Response {
  return new Response(AGENT_DOCS_MARKDOWN, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
