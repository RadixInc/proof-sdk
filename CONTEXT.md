# Proof SDK (Cloudflare fork)

Internal, self-hosted fork of Proof SDK: a collaborative markdown editor with provenance tracking and an agent HTTP bridge, re-platformed onto Cloudflare Workers behind Zero Trust, serving human and agent collaborators.

## Language

### Actors

**Human**:
A person authenticated by corporate SSO through Cloudflare Access; identified by their SSO email.
_Avoid_: user (ambiguous with agents), member

**Agent**:
A non-human client (coding agent, CI job, automation) that operates on documents through the agent bridge; admitted at the edge by an Access service token and authorized per document by a document token.
_Avoid_: bot, service

### Access & identity

**Default Role**:
The instance-wide role every Access-authenticated human holds on any ACTIVE document without needing a token.

**Document Token**:
A per-document credential (the `accessToken` of a share link) granting a specific role on that document, used by agents and for above-default human grants.
_Avoid_: share token, link token, capability token

**Owner Secret**:
The full-owner credential for a document, held by its creator (typically an agent); can pause, resume, revoke, and delete.
_Avoid_: bridge token (transport header name, not the concept)

**Role**:
What an actor may do on a document: `viewer`, `commenter`, `editor`, or owner.

### Documents

**Document**:
A collaborative markdown document identified by its slug; the unit of collaboration, storage, and access control.

**Slug**:
The short public identifier of a document, used in URLs and as the collaboration room key.

**Mark**:
An annotation anchored to a document range: a comment, suggestion, or provenance span.

**Provenance**:
The record of which actor authored which spans of a document.

**Projection**:
The derived read model of a document (markdown, marks, plain text) computed from the canonical collaborative state.

**Yjs Snapshot**:
A periodic full serialization of a document's CRDT state, used to bound replay of incremental updates.
_Avoid_: snapshot (unqualified — collides with Share Snapshot)

**Share Snapshot**:
A rendered, read-only HTML artifact of a document, stored as a static object.
_Avoid_: snapshot (unqualified — collides with Yjs Snapshot)

### Agent bridge

**Agent Bridge**:
The public HTTP contract (`AGENT_CONTRACT.md`) through which agents read state, apply ops, and poll events; held stable across the fork.

**Op**:
A typed mutation submitted by an agent (`comment.add`, `suggestion.accept`, `rewrite.apply`, …), idempotent via `Idempotency-Key`.

**Event**:
A durable, per-document queue entry an agent polls and acks to observe changes.
