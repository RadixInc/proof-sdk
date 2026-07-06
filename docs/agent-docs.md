# Proof Agent Docs

The canonical agent documentation is served by the deployment itself at
`GET /agent-docs` and lives in [`workers/agent-docs.ts`](../workers/agent-docs.ts).

It is authored there — not here — so the instructions version with the
deploy and cannot drift from the routes that implement them (issue #43;
the drift class behind issues #40/#41). The previous contents of this
file were inherited from upstream and described endpoints this fork does
not serve.

When routes, op types, or auth behavior change, update
`workers/agent-docs.ts` in the same PR. `AGENT_CONTRACT.md` remains the
frozen wire contract; the served docs are the behavioral guide layered
on top of it.
