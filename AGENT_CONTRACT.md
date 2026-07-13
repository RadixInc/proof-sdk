# Agent Contract: Direct Markdown Sharing

This contract defines the public Proof SDK flow for creating and operating on shared documents over HTTP.

> **Maintenance:** changes here (new routes, op types, or response fields) must be reflected in
> `.claude/skills/proof-docs/SKILL.md`, the client skill built against this contract.

## Endpoints

Canonical route:

`POST /documents`

Compatibility alias:

`POST /share/markdown`

Legacy internal route:

`POST /api/documents`

## Request Formats

### JSON

```http
POST /documents HTTP/1.1
Content-Type: application/json
Authorization: Bearer <apiKey>   # when API-key auth is enabled
```

```json
{
  "markdown": "# Plan\n\nShip the rewrite.",
  "title": "Rewrite Plan",
  "role": "commenter",
  "ownerId": "agent:claude"
}
```

### Raw markdown

```http
POST /documents?title=Rewrite%20Plan&role=commenter HTTP/1.1
Content-Type: text/markdown
Authorization: Bearer <apiKey>   # when API-key auth is enabled
```

````markdown
# Plan

Ship the rewrite.
````

## Response

```json
{
  "success": true,
  "slug": "abc123xy",
  "docId": "b9d9f8e8-5a4e-4af8-a9d4-5e0ecf7ff4ab",
  "url": "/d/abc123xy",
  "shareUrl": "https://your-proof.example/d/abc123xy",
  "tokenPath": "/d/abc123xy?token=...",
  "tokenUrl": "https://your-proof.example/d/abc123xy?token=...",
  "ownerSecret": "8b5f...owner secret...",
  "accessToken": "4d53...link token...",
  "accessRole": "commenter",
  "active": true,
  "shareState": "ACTIVE",
  "snapshotUrl": "https://your-proof.example/snapshots/abc123xy.html",
  "createdAt": "2026-02-12T16:10:00.000Z",
  "_links": {
    "view": "/d/abc123xy",
    "state": "/documents/abc123xy/state",
    "ops": { "method": "POST", "href": "/documents/abc123xy/ops" },
    "events": "/documents/abc123xy/events/pending?after=0",
    "docs": "/agent-docs"
  }
}
```

## Token Semantics

- `ownerSecret`
  - Full-owner credential for that document
  - Can pause, resume, revoke, delete, and perform owner-level agent actions
  - Store securely and do not expose in user-facing UI
- `accessToken`
  - Scoped link credential for `viewer`, `commenter`, or `editor`
  - Use this token for non-owner operations where possible
  - If you need a tokenized share URL, use `tokenUrl`

## Authentication Model

`PROOF_SHARE_MARKDOWN_AUTH_MODE` controls direct-share auth:

- `none`: open route, good for local/dev
- `api_key`: require `PROOF_SHARE_MARKDOWN_API_KEY`
- `auto`: resolve to `none` by default in Proof SDK

`/api/documents` is governed separately by `PROOF_LEGACY_CREATE_MODE`:

- `allow`
- `warn`
- `disabled`
- `auto`

## Delegated Agent Identity (additive)

Deployments may sit behind an edge access layer (out of this contract's
scope) where an agent is admitted either with its own machine credential
or with a credential belonging to the human it works for. In the second
case the agent declares itself:

- `x-agent-id: <id>` — optional request header, sent on every request. An
  identifier of the acting agent: 1–64 chars, `[A-Za-z0-9._-]`, starting
  alphanumeric. Invalid values are ignored (never an error). The header
  has **no effect on authorization**; it is provenance only. It is also
  ignored when the edge identity is already a machine credential.
- `operator` — optional response field, additive alongside every existing
  `actor`/`by` attribution (events, comment/suggestion/authored marks,
  comment replies): the email of the human on whose behalf a declared
  agent acted. Absent everywhere except delegated-agent actions. Actor
  string formats (`ai:<agentId>`, `human:<email>`) are unchanged.
- `GET /agent-docs` — serves the deployment's canonical agent
  instructions (markdown), including its edge-auth specifics.
- `GET /proof.SKILL.md` — serves an installable, self-contained agent
  skill file (markdown with frontmatter) teaching the auth bootstrap and
  deferring to `/agent-docs` for behavior.

## Minimal Agent Flow

1. `POST /documents`
2. Persist `ownerSecret` securely
3. Return `shareUrl` to the user
4. Use `accessToken` or `ownerSecret` for follow-up operations

## Read + Operate Contract

### Read state

- `GET /documents/:slug/state`
- `GET /api/documents/:slug/open-context`
- `GET /api/documents/:slug/collab-session`
- `GET /api/documents/:slug/info`

### Mutation endpoint

Use `POST /documents/:slug/ops` with:

- `type: "comment.add"`
- `type: "comment.reply"`
- `type: "comment.resolve"`
- `type: "suggestion.add"`
- `type: "suggestion.accept"`
- `type: "suggestion.reject"`
- `type: "rewrite.apply"`

Send `Idempotency-Key` on mutation requests so retries stay safe.

### Suggestion accept disambiguation (additive)

`suggestion.accept` re-resolves the suggestion's stored anchor against the
document's *current* markdown, since it may have changed since the
suggestion was added. If that anchor text now matches more than one place
(e.g. duplicated content), the request fails closed:

```
409 { "success": false, "code": "ANCHOR_AMBIGUOUS", "details": { "candidateCount": <n> }, "nextSteps": [...] }
```

To disambiguate, retry `suggestion.accept` with an optional `target`, using
the same shape accepted by `suggestion.add`/`comment.add`
(`{ anchor, mode?, occurrence?, contextBefore?, contextAfter? }`). When
present, it fully replaces the stored anchor for that request — supply
`occurrence: "first" | "last" | <0-based index>` and/or
`contextBefore`/`contextAfter` to pick the intended match. Omit `target`
entirely for the unchanged default behavior. `suggestion.reject` accepts
the same optional `target` field for symmetry but never needs it — reject
never re-resolves a position.

### Event polling

- Poll: `GET /documents/:slug/events/pending?after=<id>&limit=<n>`
- Ack: `POST /documents/:slug/events/ack`

### Presence heartbeat

- Announce: `POST /documents/:slug/presence` with
  `{"agentId": "<id>", "name"?: "...", "status"?: "active", "avatar"?: "..."}`.
  A bare `agentId` is normalized to `ai:<id>`; `human:`-scoped ids are
  rejected. With a delegated or machine identity, `agentId` may be omitted
  and defaults from the verified identity. Responds
  `{"success": true, "presence": {...}}`.
- Disconnect: `POST /documents/:slug/presence/disconnect` with
  `{"agentId": "<id>"}`. Idempotent; responds
  `{"success": true, "disconnected": true}`.
- Expiry is client-interpreted: viewers hide entries whose `at` heartbeat
  is older than ~60s, so re-announce while active. Any role may announce;
  presence is visibility, not a content mutation.

## Collab Session Lifecycle

1. Resolve open context and capabilities
2. Join collab with `session.collabWsUrl` and `session.token`
3. Refresh with `POST /api/documents/:slug/collab-refresh` before token expiry
4. Reconnect using the refreshed token

## CLI Example

```bash
curl -X POST http://localhost:4000/documents \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# Plan\n\nShip the rewrite.","title":"Rewrite Plan","role":"commenter"}'
```
