# Cloudflare Workers with a Durable Object per Document

Status: accepted

We are re-platforming this fork of Proof SDK from a single Node/Express/Hocuspocus process onto Cloudflare Workers, with one Durable Object per document slug as the collaboration authority. The DO owns the live Y.Doc, WebSocket connections (hibernation API), persistence to DO-attached SQLite (Yjs updates, snapshots, agent event queue, idempotency records), and per-document rate limiting; persist-debounce/compaction/eviction timers become DO Alarms. A stateless Worker routes HTTP/WS, serves static assets, and enforces auth at the edge. D1 holds the cross-document index; R2 holds HTML snapshot artifacts.

## Why

The upstream collab engine (`server/collab.ts`, ~12.5k lines) holds every live document in process-local maps and carries a large surface of breaker/quarantine/repair/lease machinery whose sole purpose is surviving multi-process and stale-write hazards. A Durable Object is a single serialized writer per document, so that hazard class disappears structurally — we delete that machinery rather than port it. This is a re-architecture, not a mechanical port: the DO implementation is written fresh against the same document model and agent-bridge contract.

## Considered options

- **Cloudflare Containers lift-and-shift** — fastest to ship, but keeps the entire single-process engine, a SQLite file on container disk, and no scale-out; not Cloudflare-native.
- **Hybrid (Workers front, containerized collab)** — two runtimes sharing one database boundary; rejected as a maintenance trap rather than a waypoint.

## Consequences

- `better-sqlite3` (synchronous, native) is replaced wholesale; all storage access becomes async against DO SQLite / D1.
- The Hocuspocus server dependency is dropped; the client provider and collab wire protocol must be re-chosen (separate decision).
- Native-binary dependencies (`@resvg/resvg-js`) cannot come along; share-preview rendering is re-decided separately.
- Per-document state (events, idempotency, y-updates) migrates out of the central database into each document's DO storage.
