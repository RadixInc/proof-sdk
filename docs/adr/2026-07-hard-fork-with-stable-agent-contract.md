# Hard Fork, but the Agent Contract and Editor Packages Stay Upstream-Stable

Status: accepted

This repo diverges from upstream Proof SDK: `server/` is rewritten for Cloudflare, hosted-product compatibility aliases, the stubbed OAuth layer, and dead dependencies are deleted, and no attempt is made to keep the Node server mergeable. Two surfaces are deliberately held invariant: (1) the public agent HTTP contract (`AGENT_CONTRACT.md` — routes, ops types, event polling/ack, idempotency semantics), so existing coding-agent tooling, skills, and docs written against Proof keep working unmodified; and (2) `packages/doc-core` and `packages/doc-editor` (document/provenance model and editor), so upstream fixes to the hairiest code we least want to own alone can still be cherry-picked.

## Considered options

- **Stay merge-compatible everywhere** (runtime-agnostic seams, dual Node/Workers builds) — rejected: roughly doubles the refactor for a merge channel that mostly ships fixes to code we are deleting.
- **Total hard fork including the agent contract** — rejected: breaks agent tooling compatibility and orphans us on ProseMirror/Yjs editor maintenance.

## Consequences

- Changes to the agent-facing API must remain backward-compatible with `AGENT_CONTRACT.md`; new capabilities are additive.
- Local modifications to `packages/doc-core`/`doc-editor` should be avoided or kept minimal to preserve cherry-pick viability.
