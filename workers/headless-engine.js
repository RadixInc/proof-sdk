/**
 * Type-boundary shim: re-exports the headless Milkdown engine for the DO.
 *
 * This is deliberately a .js file with a hand-written .d.ts next to it, so
 * the worker's strict tsc program does NOT pull the editor schema sources
 * (src/editor/**) into its check — those files belong to the upstream-stable
 * editor surface (hard-fork ADR) and do not pass the worker tsconfig.
 * Bundling (wrangler/esbuild) follows this import to the real code.
 */
export {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeMarkdown,
} from '../server/milkdown-headless.js';
