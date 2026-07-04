# y-partyserver Replaces Hocuspocus as the Yjs Sync Layer

Status: accepted

With the move to a Durable Object per document, the Hocuspocus server cannot come along (it wraps Node `ws`). We adopt `y-partyserver` (Cloudflare-owned, part of cloudflare/partykit): the document DO extends `YServer`, implementing `onLoad`/`onSave` against DO SQLite and token verification at connect; the browser swaps `HocuspocusProvider` for `YProvider`. We chose it because WebSocket-hibernation correctness — the subtle, billing-relevant part where hand-rolled Yjs servers quietly break (awareness ghosts, lost sync steps on wake) — is maintained, tested code rather than ours.

## Considered options

- **Hand-rolled y-protocols implementation in the DO** — full control, no framework at the heart of the app, but we would own ~500–800 lines of hibernation/reconnect/awareness bookkeeping where the hard bugs live.
- **Reimplementing the Hocuspocus wire protocol in the DO** — would preserve the existing client provider, but the protocol has no spec (defined only by Hocuspocus source), and the client needs rework for token refresh and offline buffering anyway.

## Consequences

- A framework dependency sits in the collaboration hot path; it is small enough (~1–2k lines) to fork or inline if abandoned.
- `src/bridge/collab-client.ts` is rewritten around `YProvider`, including re-homing the custom localStorage offline buffer and collab-token refresh flow.
- The collab WebSocket URL remains server-issued (`session.collabWsUrl`), so PartyServer's default routing conventions are an internal detail, not a contract change.
