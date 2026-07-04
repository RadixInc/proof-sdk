/**
 * Materialize wrangler.jsonc from wrangler.example.jsonc.
 *
 * The real config is never committed (public, deployment-agnostic repo — see
 * docs/adr/2026-07-deployment-agnostic-public-core.md). Deployment-specific
 * values are substituted from environment variables, which Workers Builds
 * supplies as BUILD variables (dashboard > build settings), not runtime vars:
 *
 *   D1_DATABASE_ID   your D1 database UUID (wrangler d1 create proof-sdk)
 *   WORKER_NAME      optional override of the worker name
 *
 * Local dev needs neither: wrangler dev with the placeholder ID uses local
 * SQLite. Re-running never overwrites an existing wrangler.jsonc unless
 * CF_INIT_FORCE=1 (Workers Builds sets fresh checkouts, so it always
 * regenerates there).
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

if (existsSync('wrangler.jsonc') && process.env.CF_INIT_FORCE !== '1') {
  console.log('cf-init: wrangler.jsonc already exists — leaving it untouched.');
  process.exit(0);
}

copyFileSync('wrangler.example.jsonc', 'wrangler.jsonc');
let config = readFileSync('wrangler.jsonc', 'utf8');
const substitutions = [];

if (process.env.D1_DATABASE_ID) {
  config = config.replace(D1_PLACEHOLDER, process.env.D1_DATABASE_ID);
  substitutions.push('D1_DATABASE_ID');
}
if (process.env.WORKER_NAME) {
  config = config.replace('"name": "proof-sdk"', `"name": "${process.env.WORKER_NAME}"`);
  substitutions.push('WORKER_NAME');
}

writeFileSync('wrangler.jsonc', config);
console.log(
  substitutions.length > 0
    ? `cf-init: created wrangler.jsonc (substituted: ${substitutions.join(', ')})`
    : 'cf-init: created wrangler.jsonc from example (placeholder values — fine for local dev; set D1_DATABASE_ID as a build variable for deploys)',
);
