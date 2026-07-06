# Proof SDK (Cloudflare fork)

Internal, self-hosted fork of Proof SDK: a collaborative markdown editor with provenance tracking and an agent HTTP bridge, re-platformed onto Cloudflare Workers behind Zero Trust, serving human and agent collaborators.

## Language

### Actors

**Human**:
A person authenticated by corporate SSO through Cloudflare Access; identified by their SSO email.
_Avoid_: user (ambiguous with agents), member

**Agent**:
A non-human client (coding agent, CI job, automation) that operates on documents through the agent bridge. Admitted at the edge either by its own Access service token or by its Operator's delegated credential; authorized per document by a document token or its Operator's role.
_Avoid_: bot, service

**Operator**:
The human whose credential admits a delegated Agent and on whose behalf it acts. An Agent with an Operator is still an Agent for provenance; the Operator identifies who ran it. The Human/Agent distinction under a shared credential is honest self-declaration, not a security boundary — the authenticated identity is the Operator either way.
_Avoid_: owner (collides with document ownership), supervisor

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
The record of which actor authored which spans of a document; for a delegated Agent it also records the Operator.

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
