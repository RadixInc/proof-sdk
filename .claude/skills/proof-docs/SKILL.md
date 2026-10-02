---
name: proof-docs
description: Create, share, read, and collaborate on Proof documents via the public agent HTTP contract — turn markdown into a shared document, add comments/suggestions, apply rewrites, poll for events, and hand back a share link. Trigger on requests like "share this as a doc", "create a Proof doc from this", "post a comment on that document", "what changed on that document", "check that share link's status", or any mention of a `/d/:slug` URL.
---

# proof-docs

A thin, deterministic client for a deployed Proof instance's public agent HTTP contract. It exists so agents (and you, via Claude Code) can create and operate on Proof documents against any deployment without re-deriving auth/config plumbing or mishandling secrets every time.

## Scope — read this before doing anything else

- This skill is a **client only** — it wraps whatever agent HTTP contract a Proof deployment serves. It does not add new server endpoints or product surface, and the deployment itself is the source of truth (see below) — if this skill and a live deployment disagree, the deployment wins.
- Today there is **no in-browser "New Document" button** for humans — creation is agent/API-driven by design. This skill does not attempt to fill that UX gap; if a human asks for a UI to create docs, treat that as a separate, out-of-scope product decision, not something to solve by stretching this skill.
- This skill **does not join the realtime Yjs/WebSocket collaboration session**. That's the browser editor's job. This skill only ever surfaces the `shareUrl`/`tokenUrl` it gets back from the deployment so a human can open it themselves.
- Never hardcode a real hostname or credential into this file or the script — every value shown here is a placeholder. All real config lives outside this file (see Config below), per-user and per-deployment.

## Prerequisites

- **Node.js 20 or newer.** The script has no dependencies to install (only Node built-ins), but `call` relies on the global `crypto.randomUUID()` for idempotency keys, which needs Node's global Web Crypto API (stable from Node 20 on). On an older Node it fails with a bare `ReferenceError` — if you hit that, the fix is upgrading Node, not the script.
- **`cloudflared`** — only for a non-local deployment (anything other than `localhost`/`127.0.0.1`) that isn't using a service token. Install it yourself (e.g. `brew install cloudflared`) and run `cloudflared access login <host>` once per deployment before your first request. The script will tell you if a request is missing edge credentials, but it can't install `cloudflared` for you or distinguish "not installed" from "not logged in" — if the suggested login command also fails, check whether `cloudflared` is on PATH at all.

## Start here when a document is mentioned (slug or `/d/<slug>` URL)

1. **Only this skill's script can read a Proof document.** A deployment's `/d/<slug>` URLs sit behind its own edge auth and per-document tokens. Never send one to a generic docs/artifact connector, a web fetch, or a browser scrape — those get an access denial that looks the same whether the document is missing or just not shared, and they lead you away from the real cause.
2. **Check what credentials this machine already has before asking the user for anything:**
   ```
   node <skill-dir>/scripts/proof-docs.mjs doctor <slug-or-url>
   node <skill-dir>/scripts/proof-docs.mjs secrets list
   ```
   `doctor` checks, in order, the configured host, the edge login, `/agent-docs`, the stored document credential, and `/state`, and prints the fix for the first failing step. Documents created by this skill already have a stored credential; do not ask for a share link until `secrets list` and `doctor` show there is none.
3. **If the user hands you a share link** (`https://<host>/d/<slug>?token=...`), run `link add <url>` once. It saves the token under the host and slug; after that, pass only the slug or URL. Credentials are only ever sent to the configured host: a link naming a different host is refused, not followed. If it really is the deployment you mean, run `config set --host <that origin>` first.
4. A `401` from a document endpoint means the document credential, not the edge login, was missing or wrong. The script's error says which credential it sent (the `--token` flag, a URL token, a stored `accessToken`, or none) — read that line before trying anything else.

## Source of truth — read before calling anything

Every deployment serves its own canonical, versioned reference. Prefer it over anything cached in this file or remembered from a prior session — it can't drift the way a static doc can:

- **`GET <host>/agent-docs`** — the authoritative endpoint list, request/response shapes, and op types (`comment.add`, `suggestion.accept`, `rewrite.apply`, …) for *that* deployment. Read the relevant section before constructing a request body — don't assume this SKILL.md's summaries below are complete or current.
- Terminology (`Role`, `Document Token`/`accessToken`, `Owner Secret`/`ownerSecret`, `Op`, `Event`, `Slug`) is used the way `/agent-docs` itself uses it — introduced inline there and below; no separate glossary is needed.

## Config & auth — two layers

1. **Edge (Cloudflare Access)** — every non-local deployment sits behind Access; nothing is reachable without SSO (humans) or a service token (agents). Two ways in, tried in this order by the script:
   - **Service token** pair, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers (autonomous agents; admin-provisioned).
   - **Delegated (default for a person's own agent)**: a short-lived user-scoped JWT minted by `cloudflared access token --app=<host>`, sent as `cf-access-token`. Requires a one-time `cloudflared access login <host>` browser SSO hop; if the script errors asking for it, relay that instruction to the user. Under this mode you act **as the user at the edge** — declare yourself with `x-agent-id` (the script sends it automatically, default `claude-code`) so actions attribute to the agent while the user is recorded as **Operator**: provenance only, never a security boundary — you still hold exactly the role the user holds.

   Neither is needed for local dev (`localhost`/`127.0.0.1`).
2. **App layer** — depending on the deployment's own config, creation may require an API key (`Authorization: Bearer <apiKey>`). Everything document-scoped after creation is authorized by that document's `accessToken` (non-owner ops) or `ownerSecret` (owner-level ops: pause/resume/revoke/delete).

For behavioral guidance (which ops to prefer, event etiquette), the deployment itself serves the canonical doc at `GET /agent-docs` — trust it over any cached knowledge; it versions with the server.

`scripts/proof-docs.mjs` resolves config in this order and handles both layers for you:

1. Environment variables: `PROOF_HOST`, `PROOF_API_KEY`, `PROOF_ACCESS_CLIENT_ID`, `PROOF_ACCESS_CLIENT_SECRET`, `PROOF_AGENT_ID`.
2. Saved config at `~/.config/proof-docs/config.json` (home-directory-scoped, not project-scoped — shared across every project on this machine that uses this skill, since it describes a remote deployment, not local project state).
3. If `PROOF_HOST` is still missing: **ask the user** for their instance URL (e.g. `http://localhost:4000` for local dev, or their deployed origin including scheme), then persist it:
   ```
   node <skill-dir>/scripts/proof-docs.mjs config set --host <url> [--api-key <key>] [--access-client-id <id>] [--access-client-secret <secret>] [--agent-id <id>]
   ```

## Secrets

`ownerSecret` and `accessToken` must be handled the way `/agent-docs` says: "store securely and do not expose in user-facing UI."

- Always go through `scripts/proof-docs.mjs` for create/call — it persists full secrets to `~/.config/proof-docs/secrets/<host>/<slug>.json` (mode `600`) and only ever prints a **redacted** form (e.g. `8b5f...(64 chars, saved to disk)`) to its stdout.
- **Never** manually copy a full secret value out of a raw HTTP response and paste it into the conversation — always let the script's redaction handle display.
- The first time the script ever persists a secret on a machine, it prints a one-time warning to stderr about where the file lives and that the user owns its lifecycle. **Relay that warning to the user verbatim** when you see it — don't swallow it.
- For follow-up operations on a document this skill created, the script finds the stored credential for you: the slug is read from the request path (`/documents/<slug>/...`, `/api/agent/<slug>/...`), or pass `--slug <slug-or-url>` (and `--as owner` if the op needs owner-level rights). Don't ask the user to paste a secret back in.
- If operating on a document created *outside* this skill (someone hands you a share link), save it once with `link add <url>`, or pass `--token <token>` for a single call.
- Display is redacted everywhere the script prints: `ownerSecret` and `accessToken` are truncated, and any `?token=` in a share link (`tokenUrl`, `tokenPath`) is masked. If you ever see a full token in script output, that is a bug in the script; do not repeat it in the conversation.

Local persistence (over always printing in full) is deliberate: these credentials describe a remote deployment, not per-repo state, so they're keyed by host+slug under the user's home directory and survive across every project/worktree on that machine.

## Recipes

This skill is typically installed once, user-wide, at `~/.claude/skills/proof-docs/` — not per-project. The commands below reference the bundled script as `<skill-dir>/scripts/proof-docs.mjs` — there is no environment variable that resolves this for you; substitute the actual directory containing this SKILL.md (the path you loaded it from) before running anything, e.g. `~/.claude/skills/proof-docs` at the user level, `.claude/skills/proof-docs` at the project level, or wherever a plugin unpacks it. Run the script with `--help` if you need the full flag list — this section shows shape, not the exhaustive reference, so it doesn't drift out of sync with the script.

**No content yet?** If the user asked you to create/share a document but hasn't given you markdown, ask what it should contain before doing anything else — don't invent placeholder content. Once you have real text, write it to a temp markdown file, then use that path in the recipe below.

**Create & share a document from markdown:**
```
node <skill-dir>/scripts/proof-docs.mjs create \
  --markdown-file <path> [--title "..."] [--role viewer|commenter|editor]
```
Prints the slug plus `shareUrl`/`tokenUrl` (redacted secrets). Give the user the `shareUrl` or `tokenUrl` — that's the real-time link they open in a browser to collaborate. This skill does not join that session itself.

**Read a document without flooding the terminal** (large docs run to hundreds of KB):
```
node <skill-dir>/scripts/proof-docs.mjs read <slug-or-url> [--out <file>]
```
Prints the title, revision, size and a heading outline. With `--out <file>` it writes the full state to `<file>` and the markdown to `<file>.md`; read only the part you need from there.

**Change one passage** (a targeted `rewrite.apply`; prefer this to replacing the whole document):
```
node <skill-dir>/scripts/proof-docs.mjs replace <slug-or-url> \
  --find "<exact text>" --with "<new text>" [--find-file <path> --with-file <path>]
```
It reads the current revision, requires `--find` to match exactly once (quote markdown escapes such as `\*` as they appear), and posts the change against that revision. A `409 STALE_BASE` means the document moved: run it again. Use `--find-file`/`--with-file` for a multi-line change such as a table row.

**Anything else in the contract** (apply other ops, poll/ack events) goes through the generic authenticated call:
```
node <skill-dir>/scripts/proof-docs.mjs call <METHOD> <path> \
  [--slug <slug-or-url>] [--as owner|link] [--body '<json>'] [--body-file <path>]
```
`--slug` is optional for document paths; the slug in the path selects the stored credential. Look up the exact `<path>` and body shape in `GET <host>/agent-docs` first. Examples of shape (verify against that live reference before relying on these):
- Read state: `call GET /documents/<slug>/state`
- Add a comment: `call POST /documents/<slug>/ops --body '{"type":"comment.add", ...}'`
- Poll events: `call GET "/documents/<slug>/events/pending?after=0&limit=50"`
- Ack events: `call POST /documents/<slug>/events/ack --body '{"ids":[...]}'`

**Save a share link, check what's stored, diagnose a failure:**
```
node <skill-dir>/scripts/proof-docs.mjs link add <share-url>
node <skill-dir>/scripts/proof-docs.mjs secrets list
node <skill-dir>/scripts/proof-docs.mjs secrets show <slug-or-url>
node <skill-dir>/scripts/proof-docs.mjs doctor [<slug-or-url>]
```
`secrets list` shows the documents this machine has credentials for (never the secret values). `doctor` prints an ok/FAIL line per layer — edge login, `/agent-docs`, stored credential, `/state` — so a failure points at the layer that broke.
