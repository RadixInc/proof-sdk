# proof-docs Skill Persists Owner Secrets Locally, Outside the Repo

Status: accepted

The `proof-docs` Claude Code skill (`.claude/skills/proof-docs/`) creates and operates on documents via `AGENT_CONTRACT.md` on behalf of a human or agent. `POST /documents` returns an `ownerSecret` and `accessToken` that the contract says to "store securely and do not expose in user-facing UI." Left alone, these would flow through the conversation transcript in full — a mild but real leak, since transcripts get shared, logged, and screenshotted. We decided the skill writes them to a local file under the user's home directory (`~/.config/proof-docs/`, keyed by host+slug), echoes only a truncated form back to the transcript, and explicitly warns the user the first time a doc is created so the persistence isn't silent. Home directory rather than the project repo (even gitignored) because these credentials describe a remote deployed instance, not per-worktree state — a project-root file would need re-entering in every git worktree of this repo for no benefit.

## Considered options

- **Never persist, always print in full** — rejected: treats a secret meant to be "stored securely" the same as any other API response; pushes all responsibility onto the user with no support from the skill.
- **Persist silently with no warning** — rejected: creates an unannounced credential store on disk the user may not know exists or think to secure/clean up.
- **Project-root gitignored file** — rejected: duplicates config per git worktree despite the credentials being tied to a remote instance, not local repo state.

## Consequences

- Other organizations deploying this public fork and adopting the skill inherit plaintext secret storage in `~/.config/proof-docs/` on any machine that runs it; this is a deliberate convenience/security trade-off, not an oversight, and should be revisited if a stronger local secret store becomes a hard requirement.
- Because storage is home-directory-scoped, secrets survive across worktrees/clones of the same repo on one machine, and are the user's responsibility to rotate/delete (via `ownerSecret`'s revoke/delete capability) if a machine is compromised.
