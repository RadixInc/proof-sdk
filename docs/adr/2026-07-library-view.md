# `/library` View: Real Data Only, a Second Vite Entry, Vanilla TS

Status: accepted

`/library` previously rendered a bare server-side HTML fragment (`workers/library.ts`'s `renderLibraryHtml`) with no client interactivity. We're replacing it with the redesign ported from the Claude Design project "Proof Editor Redesign Brief" (`Proof Library.html` / `library.jsx` / `library.css`): search, sort, grid/list layout, and view filters (Recent / Owned by me / Shared with me / All documents), backed by the existing `GET /api/library` endpoint (`workers/library.ts`'s `queryLibrary`, unchanged).

## Real data only, not a faithful mock port

The mock's cards show fields the backend doesn't have: a content snippet, a human/AI/mixed provenance rollup, an open-comment count, a live "agent is drafting" badge, a per-document collaborator avatar stack, a star toggle, and a "+ New Document" button. Rather than ship fabricated data in a real product surface, this view renders exactly what `/api/library` returns — title, role, owned, shareState, recency, visitCount — and the "Activity" sort uses `visitCount` as a documented real proxy for the mock's comment-count-based sort.

What's deferred, and why:

- **Snippet, provenance rollup, comment count** (#71) — all three share one fix: the `DocumentDO` writes a denormalized summary onto its `documents` D1 row on persist/mutation. No Durable Object fan-out from the library query — that constraint is explicit in `workers/library.ts`'s header comment ("queries are D1-only... no DO fan-out"), and computing these per-row today would mean opening every listed document's DO, which is exactly what that file was built to avoid.
- **Starring** (#72) — doesn't exist at all (no table, no endpoint); a standalone addition with no architectural conflict.
- **"New Document" button** (#73) — discovered while scoping this change: there is no human-facing document-creation route at all. `createDocument` (`workers/api.ts`) is reachable only via the Agent Contract's `POST /documents`; `/new` is a stale dev-proxy rule. Wiring the button to a dead route, or faking creation client-side, was rejected; the button is omitted until #73 resolves the product question of whether humans should create documents directly at all (a VISION.md Purpose question, not just a missing route).
- **Live agent-drafting badge, per-doc collaborator avatars, org-wide "browse every document" reading of "All documents"** — flagged as open questions, not filed as issues. Live presence at list-scale means either DO fan-out (the thing this file avoids) or losing the "live" semantics via denormalization; a collaborator stack needs a cross-user query this per-viewer-scoped library was deliberately not built for, plus there's no display-name/color registry (only emails); and an unscoped every-document listing edges toward the "open-by-default social surface" `docs/VISION.md`'s anti-goals disclaim (not a SaaS, no per-user ACL system). These stay flagged per CLAUDE.md's Open-Questions handling rather than decided here.

## A second Vite entry point, not a client route in the existing bundle

`src/editor/index.ts` has no client-side router — "pages" are `if (location.pathname === ...)` branches inside one monolithic bundle, and `vite.config.ts` builds it as a single IIFE chunk (`build.rollupOptions.output.inlineDynamicImports: true`, `modulePreload: false`) deliberately, to keep the editor trivially embeddable in external hosts.

Adding `/library` as another branch in that bundle was rejected: it has no embedding requirement, and Rollup rejects `inlineDynamicImports: true` combined with multiple entry points, so simply adding a second `input` to the existing config would break the build. Instead, `/library` gets its own entry (`src/library.html`, `src/library-view/main.ts`) built by a **separate** config, `vite.library.config.ts` (default ESM output, `emptyOutDir: false`, writing into the same `dist/`). `package.json`'s `build` script runs both. This also means the main config's deliberately-tuned embeddability settings are untouched.

`workers/api.ts`'s `/library` branch (human-only, same gate as `/api/library`) now serves the built shell directly: `env.ASSETS.fetch(new Request(new URL('/library.html', request.url), request))`, so Vite's own `<head>` stays the single source of truth instead of a hand-duplicated one in the Worker. This required widening `ApiEnv` with `ASSETS: Fetcher`.

## Vanilla TS, not React

The mock's React is a Claude Design authoring convenience (see the design project's own `README.md`: "design every screen from scratch... no components to compose from `window.*`"). This codebase has no React dependency, and every chrome widget (`src/ui/*.ts`) is vanilla TS with template-string rendering. `src/library-view/main.ts` follows that same convention rather than introducing a framework for one page.

## Tokens

`library.css`'s token names (`--surface`, `--surface-2/3`, `--border`, `--text`, `--text-2/muted/faint`, `--btn-bg(-hover)`, `--r-xs..pill`, `--sh-sm/md`, `--link(-hover)`, `--ring`, `--ui-font`) already exist verbatim in `src/index.html`'s inline `:root` / `:root[data-appearance="dark"]` blocks — no new token vocabulary was needed. `src/library.html` hand-copies just this subset into its own inline `<style>` (the same self-contained-per-entry-point pattern `index.html` itself uses) rather than extracting a shared tokens file out of the actively-changing, 1400+ line `index.html` — out of scope for this change. This is a deliberate copy, not a reference; if the source values in `index.html` change, this subset needs a manual update. Light/dark state itself is shared with the editor via the same `data-appearance` attribute and `proof-appearance` localStorage key `src/ui/theme-picker.ts` uses — but `ThemePicker` isn't instantiated directly, since its rendered switcher bundles document-view/read-theme controls that don't apply to a listing page.

## Consequences

- `workers/library.ts`'s `renderLibraryHtml`/`escapeHtml` are removed; `queryLibrary`/`recordVisit` and the `/api/library` JSON contract are unchanged.
- `src/tests/worker-library.test.ts`'s HTML assertion now checks that the SPA shell is served (`id="app"` mount point) rather than literal row text, since rendering is client-side; every other assertion (JSON shape, per-user scoping, delete handling, agent 403) is unchanged.
- Follow-up issues: #71 (denormalized snippet/provenance/comment-count), #72 (starring), #73 (human document-creation flow).
