# Share Activity: A New Read-Only History Endpoint, Distinct From Agent Bridge Events

Status: accepted

The Share menu's "View activity" modal has been dead since the initial OSS extraction: it read from a Yjs `agentActivity` array that nothing ever wrote to. We're replacing it with a real feature — a human-facing history of everything that happened to a document (comments, replies, resolutions, suggestion decisions, rewrites, title/pause/resume/revoke), sourced from the same `document_event` SQLite table the Agent Bridge already writes via `addEvent`/`listEvents` (`workers/document-do.ts`).

## Activity is a new term, distinct from Event

`CONTEXT.md`'s existing **Event** is scoped to the Agent Bridge: "a durable, per-document queue entry an agent polls and acks to observe changes." That framing — polling cursor, ack-to-advance — is a queue-consumption concept, not a history-viewing one. We introduce **Activity** as its own glossary term: the read-only human view over the same log, with no poll/ack semantics attached to the concept itself.

## A new endpoint, not an extension of `/events/pending`

`listEvents` paginates forward from a cursor (`WHERE id > ? ORDER BY id ASC LIMIT ?`) — correct for an agent resuming where it left off, wrong for "show me the most recent N events," which needs `ORDER BY id DESC`. Rather than growing `/events/pending` (documented in the frozen `AGENT_CONTRACT.md`) with human-display concerns, we add `GET /documents/:slug/activity`: same underlying table, `DESC`-ordered, and a response shape that omits Agent Bridge internals (`ackedAt`, `ackedBy`, `cursor`) that have no meaning for a read-only viewer. Access parity matches `/events/pending`'s `gateEventsAccess` — any role that can open the document — consistent with the documented security model (no anonymous access exists in this deployment; there is no per-user ACL to layer on top).

## First UI surface to render actor identity, not just category

The existing provenance UI (`heatmap-decorations.ts`, `provenance-legend.ts`) classifies spans into three categories — Human / AI / Mixed — and never names a specific person or agent. Activity is the first surface that renders actual identity: human actors via `deriveDisplayNameFromEmail`, agents via `deriveAgentNameFromId`, and delegated agents as `"<Agent> (via <Operator>)"`, matching the Operator definition in `CONTEXT.md` exactly. No prior UI convention existed for this; we're establishing it here rather than deferring it, since the formatting helpers already exist and shipping raw internal ids (`agent:foo-bar`) in a human-facing modal would be a worse default.

## Considered options

- **Widen `Event`'s definition to cover human display too** — rejected: collapses a distinction (queue primitive vs. history view) the glossary already keeps precise elsewhere (e.g. Yjs Snapshot vs. Share Snapshot).
- **Add a `desc`/`before` param to `listEvents`/`/events/pending` instead of a new endpoint** — rejected: couples a human-UI concern to the frozen, agent-facing contract.
- **Wire the original Yjs `agentActivity` array server-side**, matching the dead code's original architecture — rejected: requires duplicating events into a second storage mechanism (Yjs array + SQLite table) that must stay consistent, and an unbounded ever-growing log is a poor fit for a CRDT array.
- **Live-poll the modal while open** — rejected for v1: this is a history viewer opened from a menu, not a monitoring dashboard; nothing else in the Share menu is live-updating.
- **Cursor-based "load more" pagination past the last 50** — rejected for v1: ships the same scope as the original dead code (`.slice(-50)`); add a `before` cursor later if real usage shows people need to dig further back.

## Consequences

- The dead `agentActivity`/`shareAgentActivityItems`/`shareAgentActivitySignature` wiring in `installShareAgentPresenceObservers` (`src/editor/index.ts`) is removed in the same change, leaving the real, working `agentPresence`/`agentCursors` observers untouched.
- `GET /documents/:slug/activity` is additive and outside `AGENT_CONTRACT.md`'s scope — it is a UI-facing endpoint, not part of the agent bridge, and should not be advertised in `_links` or `/agent-docs`.
- If a future feature needs agent-only activity (e.g. "is an agent working on this doc right now"), that's a filter over the same Activity data (by actor prefix), not a reason to reintroduce the old Yjs-array design.
