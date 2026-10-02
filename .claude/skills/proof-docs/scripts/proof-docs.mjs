#!/usr/bin/env node
// Deterministic transport for the proof-docs skill: config resolution, two-layer auth,
// and secret persistence live here so the agent never has to hand-roll them (or the
// full ownerSecret/accessToken) inside the conversation transcript.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'proof-docs');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
const SECRET_FIELDS = ['ownerSecret', 'accessToken'];
// Fields the API fills with share links; only these get ?token= masked, so document text that
// happens to contain "?token=" comes back unchanged.
const LINK_FIELDS = ['tokenUrl', 'tokenPath'];
const TOKEN_QUERY = /([?&]token=)[^&\s"'<>]+/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig() {
  const saved = readJson(CONFIG_FILE);
  return {
    host: process.env.PROOF_HOST || saved.host,
    apiKey: process.env.PROOF_API_KEY || saved.apiKey,
    accessClientId: process.env.PROOF_ACCESS_CLIENT_ID || saved.accessClientId,
    accessClientSecret: process.env.PROOF_ACCESS_CLIENT_SECRET || saved.accessClientSecret,
    // Delegated-agent declaration (AGENT_CONTRACT.md "Delegated Agent
    // Identity"): provenance only, ignored by servers that predate it.
    agentId: process.env.PROOF_AGENT_ID || saved.agentId || 'claude-code',
  };
}

/**
 * Delegated edge auth: when no Access service token is configured, mint a
 * short-lived user-scoped Access JWT through cloudflared (the user's SSO
 * session). Requires cloudflared and a prior `cloudflared access login
 * <host>`. Returns null when cloudflared is unavailable or unauthenticated
 * so the caller can produce a useful error.
 */
function delegatedAccessToken(host) {
  try {
    const token = execFileSync('cloudflared', ['access', 'token', `--app=${host}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

function requireHost(config) {
  if (!config.host) {
    throw new Error(
      'No Proof host configured. Ask the user for their instance URL (e.g. http://localhost:4000 ' +
      'for local dev, or their deployed origin), then run: config set --host <url>'
    );
  }
  return config.host;
}

function isLocalHost(host) {
  try {
    const { hostname } = new URL(host);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function buildHeaders(config, extra = {}) {
  const headers = { ...extra };
  // A per-document token (passed in `extra.Authorization`) must win over the creation API
  // key; otherwise configuring an API key silently replaces the document credential.
  if (config.apiKey && !headers.Authorization) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.agentId) headers['x-agent-id'] = config.agentId;
  if (!isLocalHost(config.host)) {
    if (config.accessClientId && config.accessClientSecret) {
      headers['CF-Access-Client-Id'] = config.accessClientId;
      headers['CF-Access-Client-Secret'] = config.accessClientSecret;
    } else {
      const token = delegatedAccessToken(config.host);
      if (!token) {
        throw new Error(
          `Host ${config.host} is behind Cloudflare Access and no edge credential is available. ` +
          'Either configure a service token (config set --access-client-id ... --access-client-secret ...) ' +
          `or authenticate as yourself once with: cloudflared access login ${config.host}`
        );
      }
      headers['cf-access-token'] = token;
    }
  }
  return headers;
}

function truncate(value) {
  if (typeof value !== 'string' || value.length <= 8) return value;
  return `${value.slice(0, 4)}...(${value.length} chars, saved to disk)`;
}

// Every secret value found anywhere in the object (not just under a known key), so a
// copy of the token embedded in another field (e.g. tokenUrl) can be masked too.
function collectSecretValues(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectSecretValues(v, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELDS.includes(k) && typeof v === 'string' && v.length > 8) found.add(v);
      else collectSecretValues(v, found);
    }
  }
  return found;
}

function maskString(str, secrets) {
  let out = str;
  for (const secret of secrets) out = out.split(secret).join(truncate(secret));
  return out;
}

function redact(value, secrets = collectSecretValues(value)) {
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELDS.includes(k)) out[k] = truncate(v);
      else if (LINK_FIELDS.includes(k) && typeof v === 'string') out[k] = maskString(v.replace(TOKEN_QUERY, '$1<redacted>'), secrets);
      else out[k] = redact(v, secrets);
    }
    return out;
  }
  return typeof value === 'string' ? maskString(value, secrets) : value;
}

function sanitizeHost(host) {
  return host.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function assertValidSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(`Invalid slug "${slug}": expected only alphanumerics, "-", "_"`);
  }
}

function secretsFile(host, slug) {
  assertValidSlug(slug);
  return path.join(SECRETS_DIR, sanitizeHost(host), `${slug}.json`);
}

function saveSecrets(host, slug, data) {
  const firstEver = !fs.existsSync(SECRETS_DIR);
  const dir = path.join(SECRETS_DIR, sanitizeHost(host));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = secretsFile(host, slug);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (firstEver) {
    process.stderr.write(
      '\n[proof-docs] First document created on this machine. Owner secrets and access tokens are\n' +
      `being stored in plaintext at ${SECRETS_DIR} (one file per document, mode 600).\n` +
      'You are responsible for that file\'s lifecycle: back it up if you need it, or revoke/delete\n' +
      'the document (via its ownerSecret) and remove the file if this machine is ever compromised.\n' +
      'This warning only prints once. Relay it to the user now.\n\n'
    );
  }
  return file;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

class HttpError extends Error {
  constructor(status, statusText, body) {
    super(`HTTP ${status} ${statusText}: ${JSON.stringify(redact(body))}`);
    this.status = status;
    this.body = body;
  }
}

async function doFetch(url, options) {
  // Never follow redirects: fetch would carry CF-Access-Client-* headers to the new origin.
  const res = await fetch(url, { ...options, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(res.status, res.statusText, `redirect to ${res.headers.get('location') || '(no location)'} not followed; credentials are only sent to the configured host`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new HttpError(res.status, res.statusText, body);
  return body;
}

/** Slug embedded in an agent-contract path, e.g. /documents/<slug>/state or /api/agent/<slug>/ops. */
function slugFromPath(reqPath) {
  const match = /^\/(?:documents|api\/agent)\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/.exec(reqPath);
  return match ? match[1] : undefined;
}

/**
 * Accepts a bare slug or a document URL (https://host/d/<slug>[?token=...], or a
 * /documents/<slug> URL) and returns { host?, slug, token? }. A URL carries its own host,
 * which wins over the configured one for that call.
 */
function parseDocRef(input, defaultHost) {
  if (typeof input !== 'string' || !input) throw new Error('Expected a slug or document URL');
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const match = /^\/(?:d|documents|api\/agent)\/([a-zA-Z0-9_-]+)/.exec(url.pathname);
    if (!match) throw new Error(`Could not find a document slug in URL path "${url.pathname}" (expected /d/<slug>)`);
    return { host: url.origin, slug: match[1], token: url.searchParams.get('token') || undefined };
  }
  assertValidSlug(input);
  return { host: defaultHost, slug: input };
}

/**
 * Credentials (edge service token, API key, document token) are only ever sent to the configured
 * host. A URL naming a different host is refused rather than followed, so a pasted or injected
 * link cannot redirect them to another server.
 */
function assertConfiguredHost(urlHost, configuredHost) {
  if (!urlHost || !configuredHost) return;
  if (new URL(urlHost).origin !== new URL(configuredHost).origin) {
    throw new Error(
      `The link points at ${urlHost}, but the configured host is ${configuredHost}. Credentials are only ` +
      'sent to the configured host. If that link is the deployment you mean, run: config set --host ' + urlHost
    );
  }
}

function storedSecretsOrNull(host, slug) {
  const file = secretsFile(host, slug);
  return fs.existsSync(file) ? readJson(file) : null;
}

/**
 * Choose the document credential for a call and say where it came from, so a 401 can be
 * explained instead of just repeated. Order: --token, token in a URL, stored secrets.
 */
function chooseCredential({ host, slug, explicitToken, urlToken, as, strict }) {
  if (explicitToken) return { token: explicitToken, source: 'the --token flag' };
  if (urlToken) return { token: urlToken, source: 'the ?token= in the URL you passed' };
  if (!slug) return { token: undefined, source: 'none (no slug in the request path and no --slug/--token)' };
  const stored = storedSecretsOrNull(host, slug);
  if (!stored) {
    if (strict) {
      throw new Error(
        `No stored credentials for slug "${slug}" at ${host} (looked in ${secretsFile(host, slug)}). ` +
        'Run `secrets list` to see which documents this machine has credentials for, or pass a share ' +
        'link with `link add <url>` / --token if this document was created elsewhere.'
      );
    }
    return { token: undefined, source: `none (no stored credentials for slug "${slug}" at ${host})` };
  }
  const field = as === 'owner' ? 'ownerSecret' : 'accessToken';
  if (!stored[field]) throw new Error(`Stored record for "${slug}" has no ${field}`);
  return { token: stored[field], source: `stored ${field} for "${slug}"` };
}

/** One-line explanation for an HTTP failure, naming which credential was (not) sent. */
function explainFailure(err, { source, host }) {
  if (!(err instanceof HttpError)) return '';
  const { status, body } = err;
  if (status !== 401 && status !== 403) return '';
  const looksEdge = typeof body === 'string' || (body && typeof body === 'object' && !('code' in body));
  if (looksEdge) {
    return `\nHint: this looks like a Cloudflare Access rejection, not a document one. Run: cloudflared access login ${host} (or run \`doctor\`).`;
  }
  if (/^none/.test(source)) {
    return `\nHint: no document credential was sent — ${source}. Run \`secrets list\`, then retry with --slug <slug>, a share link via \`link add <url>\`, or --token.`;
  }
  return `\nHint: the server rejected the credential that was sent (${source}). It may be revoked or have too little role; ask for a fresh share link and \`link add <url>\`, or retry with --as owner for owner-level ops.`;
}

// Piping into `head` closes stdout early; that is not an error worth a stack trace.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err;
  process.exit(0);
});

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function cmdConfigShow() {
  const config = loadConfig();
  print(redact({ ...config, configFile: CONFIG_FILE }));
}

async function cmdConfigSet(flags) {
  const current = readJson(CONFIG_FILE);
  const next = {
    host: flags.host ?? current.host,
    apiKey: flags['api-key'] ?? current.apiKey,
    accessClientId: flags['access-client-id'] ?? current.accessClientId,
    accessClientSecret: flags['access-client-secret'] ?? current.accessClientSecret,
    agentId: flags['agent-id'] ?? current.agentId,
  };
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  print({ saved: CONFIG_FILE, config: redact(next) });
}

async function cmdCreate(flags) {
  const config = loadConfig();
  const host = requireHost(config);

  let body;
  if (flags['json-body-file']) {
    body = readJson(flags['json-body-file']);
  } else {
    if (!flags['markdown-file']) throw new Error('create requires --markdown-file <path> (or --json-body-file <path>)');
    const markdown = fs.readFileSync(flags['markdown-file'], 'utf8');
    body = { markdown };
    if (flags.title) body.title = flags.title;
    if (flags.role) body.role = flags.role;
  }

  const headers = buildHeaders(config, { 'Content-Type': 'application/json' });
  const result = await doFetch(`${host}/documents`, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!result.slug) throw new Error(`Unexpected response from POST /documents: ${JSON.stringify(result)}`);
  const file = saveSecrets(host, result.slug, result);
  print({ ...redact(result), secretsFile: file });
}

function parseHeaderFlag(flag) {
  const out = {};
  if (!flag) return out;
  for (const h of Array.isArray(flag) ? flag : [flag]) {
    const idx = h.indexOf(':');
    if (idx > 0) out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Shared request path for call/read/replace: resolves host, slug and credential, then sends.
 * `ref` is the --slug flag or a positional (bare slug or document URL); the slug in the request
 * path is the fallback, so `call GET /documents/<slug>/state` works without --slug.
 */
async function authedRequest(config, { method, reqPath, ref, flags, body, extraHeaders = {} }) {
  const parsed = ref ? parseDocRef(ref, config.host) : null;
  const host = requireHost(config);
  if (parsed) assertConfiguredHost(parsed.host, host);
  const slug = parsed?.slug ?? slugFromPath(reqPath);
  const { token, source } = chooseCredential({
    host,
    slug,
    explicitToken: flags.token,
    urlToken: parsed?.token,
    as: flags.as || 'link',
    strict: Boolean(parsed),
  });

  const headers = { ...extraHeaders, ...parseHeaderFlag(flags.header) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (method !== 'GET' && !headers['Idempotency-Key']) headers['Idempotency-Key'] = crypto.randomUUID();

  const scoped = { ...config, host };
  const url = `${host}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`;
  try {
    return await doFetch(url, { method, headers: buildHeaders(scoped, headers), body });
  } catch (err) {
    err.message += explainFailure(err, { source, host });
    throw err;
  }
}

async function cmdCall(positional, flags) {
  const config = loadConfig();
  const [methodArg, reqPath] = positional;
  if (!methodArg || !reqPath) throw new Error('call requires <METHOD> <path>, e.g. call GET /documents/abc123xy/state');

  let body;
  if (flags['body-file']) body = fs.readFileSync(flags['body-file'], 'utf8');
  else if (typeof flags.body === 'string') body = flags.body;

  const result = await authedRequest(config, {
    method: methodArg.toUpperCase(),
    reqPath,
    ref: typeof flags.slug === 'string' ? flags.slug : undefined,
    flags,
    body,
  });
  print(redact(result));
}

async function cmdLinkAdd(positional) {
  const config = loadConfig();
  const [input] = positional;
  if (!input) throw new Error('link add requires a document share link, e.g. https://<host>/d/<slug>?token=<token>');
  const { host, slug, token } = parseDocRef(input, config.host);
  if (!token) throw new Error('That link has no ?token= — nothing to save. Ask for the share link (tokenUrl), not the plain /d/<slug> URL.');
  if (!host) throw new Error('No host: pass a full URL, or run config set --host <url>');
  const existing = storedSecretsOrNull(host, slug) || {};
  const record = { ...existing, slug, accessToken: token, shareUrl: `${host}/d/${slug}` };
  const file = saveSecrets(host, slug, record);
  print({ saved: file, host, slug, accessToken: truncate(token) });
}

async function cmdSecretsShow(positional) {
  const config = loadConfig();
  const [input] = positional;
  if (!input) throw new Error('secrets show requires <slug-or-url>');
  const { host, slug } = parseDocRef(input, config.host);
  const useHost = host ?? requireHost(config);
  const stored = chooseStored(useHost, slug);
  print({ ...redact(stored), secretsFile: secretsFile(useHost, slug) });
}

function chooseStored(host, slug) {
  const stored = storedSecretsOrNull(host, slug);
  if (!stored) {
    throw new Error(`No stored credentials for slug "${slug}" at ${host}. Run \`secrets list\` to see what is stored.`);
  }
  return stored;
}

async function cmdSecretsList(flags) {
  const config = loadConfig();
  const host = typeof flags.host === 'string' ? flags.host : requireHost(config);
  const dir = path.join(SECRETS_DIR, sanitizeHost(host));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const rows = files.map((f) => {
    const rec = readJson(path.join(dir, f));
    return {
      slug: rec.slug || f.replace(/\.json$/, ''),
      title: rec.title,
      role: rec.accessRole,
      hasOwnerSecret: Boolean(rec.ownerSecret),
      hasAccessToken: Boolean(rec.accessToken),
      createdAt: rec.createdAt,
    };
  });
  print({ host, count: rows.length, documents: rows });
}

function outline(markdown) {
  return markdown.split('\n').filter((l) => /^#{1,3} /.test(l)).map((l) => l.slice(0, 100));
}

async function cmdRead(positional, flags) {
  const config = loadConfig();
  const [input] = positional;
  if (!input) throw new Error('read requires <slug-or-url> [--out <file>]');
  const { slug } = parseDocRef(input, config.host);
  const state = await authedRequest(config, { method: 'GET', reqPath: `/documents/${slug}/state`, ref: input, flags });
  const markdown = typeof state.markdown === 'string' ? state.markdown : '';
  if (typeof flags.out === 'string') {
    fs.writeFileSync(flags.out, JSON.stringify(redact(state), null, 2), { mode: 0o600 });
    fs.writeFileSync(`${flags.out}.md`, markdown, { mode: 0o600 });
  }
  print({
    slug,
    title: state.title,
    revision: state.revision,
    markdownChars: markdown.length,
    outline: outline(markdown),
    ...(typeof flags.out === 'string' ? { wrote: [flags.out, `${flags.out}.md`] } : { hint: 'pass --out <file> to save the full state and markdown to disk' }),
  });
}

function readTextFlag(flags, name) {
  if (typeof flags[`${name}-file`] === 'string') return fs.readFileSync(flags[`${name}-file`], 'utf8');
  return typeof flags[name] === 'string' ? flags[name] : undefined;
}

async function cmdReplace(positional, flags) {
  const config = loadConfig();
  const [input] = positional;
  const find = readTextFlag(flags, 'find');
  const replacement = readTextFlag(flags, 'with');
  if (!input || find === undefined || replacement === undefined) {
    throw new Error('replace requires <slug-or-url> and --find/--with (or --find-file/--with-file)');
  }
  const { slug } = parseDocRef(input, config.host);
  const state = await authedRequest(config, { method: 'GET', reqPath: `/documents/${slug}/state`, ref: input, flags });
  const markdown = state.markdown || '';
  const occurrences = markdown.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      occurrences === 0
        ? 'find text not found in the current markdown. Quote it exactly as it appears (including markdown escapes such as \\* or \\_).'
        : `find text occurs ${occurrences} times; extend it until it is unique.`
    );
  }
  const baseRevision = flags['base-revision'] ? Number(flags['base-revision']) : state.revision;
  const result = await authedRequest(config, {
    method: 'POST',
    reqPath: `/documents/${slug}/ops`,
    ref: input,
    flags,
    body: JSON.stringify({ type: 'rewrite.apply', payload: { baseRevision, changes: [{ find, replace: replacement }] } }),
  });
  print({ ok: result.success ?? true, slug, fromRevision: baseRevision, revision: result.revision, eventId: result.eventId });
}

async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual' });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: err.message };
  }
}

async function cmdDoctor(positional, flags) {
  const config = loadConfig();
  const results = [];
  const step = (name, ok, detail) => {
    results.push(ok);
    process.stdout.write(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
  };

  const parsed = positional[0] ? parseDocRef(positional[0], config.host) : null;
  const host = config.host;
  if (!host) return step('host', false, 'none configured; run config set --host <url>');
  if (parsed) assertConfiguredHost(parsed.host, host);
  step('host', true, host);

  let edgeHeaders = {};
  if (isLocalHost(host)) {
    step('edge auth', true, 'local host, no Cloudflare Access');
  } else if (config.accessClientId && config.accessClientSecret) {
    step('edge auth', true, 'service token configured');
    edgeHeaders = buildHeaders({ ...config, host });
  } else {
    const token = delegatedAccessToken(host);
    step('edge auth', Boolean(token), token ? 'delegated Access JWT from cloudflared' : `no token; run: cloudflared access login ${host}`);
    if (!token) return;
    edgeHeaders = buildHeaders({ ...config, host });
  }

  const docs = await probe(`${host}/agent-docs`, edgeHeaders);
  step('GET /agent-docs', docs.status === 200, `HTTP ${docs.status}${docs.status === 200 ? '' : ' — edge credential rejected or host unreachable'}`);
  if (docs.status !== 200 || !parsed) return;

  const { token, source } = chooseCredential({
    host,
    slug: parsed.slug,
    explicitToken: flags.token,
    urlToken: parsed.token,
    as: flags.as || 'link',
    strict: false,
  });
  step('document credential', Boolean(token), token ? source : `${source}; run secrets list, or link add <url>`);
  if (!token) return;

  const state = await probe(`${host}/documents/${parsed.slug}/state`, { ...edgeHeaders, Authorization: `Bearer ${token}` });
  step(`GET /documents/${parsed.slug}/state`, state.status === 200, state.status === 200 ? `revision ${state.body?.revision}` : `HTTP ${state.status}`);
}

function help() {
  process.stdout.write(`proof-docs.mjs — transport helper for the proof-docs skill

  config show
  config set [--host <url>] [--api-key <key>] [--access-client-id <id>] [--access-client-secret <secret>]
             [--agent-id <id>]

  create --markdown-file <path> [--title <title>] [--role viewer|commenter|editor]
  create --json-body-file <path>
      Creates a document via POST /documents, saves ownerSecret/accessToken to
      ~/.config/proof-docs/secrets/<host>/<slug>.json, prints a redacted summary.

  call <METHOD> <path> [--slug <slug-or-url>] [--as owner|link] [--token <token>]
       [--body <json>] [--body-file <path>] [--header "Name: value"]
      Generic authenticated request for anything else in the deployment's
      agent contract (state, ops, events poll/ack, etc). The slug is taken from
      the request path (/documents/<slug>/... or /api/agent/<slug>/...) when
      --slug is omitted, and the stored credential for it is used. --token or a
      ?token= in a --slug URL overrides. A 401/403 prints which credential was
      (or was not) sent. Read GET <host>/agent-docs for the exact path/body
      shape of each endpoint — that deployment-served reference is authoritative.

  read <slug-or-url> [--out <file>]
      Prints title, revision, size and a heading outline. With --out, writes the
      full state to <file> and the markdown to <file>.md instead of the terminal.

  replace <slug-or-url> --find <text> --with <text> [--find-file/--with-file <path>]
          [--base-revision <n>]
      Targeted rewrite.apply: reads the current revision, requires --find to occur
      exactly once, and posts a single change against that revision.

  link add <url>
      Saves the token from a share link (https://<host>/d/<slug>?token=...) for a
      document created elsewhere, so later calls need no --token.

  secrets list [--host <url>]
  secrets show <slug-or-url>
      list: documents this machine has credentials for (no secret values).
      show: the stored (redacted) credential record and its file path.

  doctor [<slug-or-url>]
      Checks host, edge login, /agent-docs, the stored document credential, and
      /state, printing ok/FAIL with the fix for the first failure.

Config resolution order: env vars (PROOF_HOST, PROOF_API_KEY,
PROOF_ACCESS_CLIENT_ID, PROOF_ACCESS_CLIENT_SECRET, PROOF_AGENT_ID) >
~/.config/proof-docs/config.json.
Edge auth (non-local hosts only): service token headers when configured,
otherwise a delegated user JWT via \`cloudflared access token\` (run
\`cloudflared access login <host>\` once first). Every request carries
x-agent-id (default "claude-code") so actions attribute to the agent with
the signed-in human recorded as operator.
`);
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'config' && sub === 'show') return await cmdConfigShow();
    if (cmd === 'config' && sub === 'set') return await cmdConfigSet(parseArgs(rest).flags);
    if (cmd === 'create') return await cmdCreate(parseArgs([sub, ...rest].filter(Boolean)).flags);
    if (cmd === 'call') {
      const { positional, flags } = parseArgs([sub, ...rest].filter(Boolean));
      return await cmdCall(positional, flags);
    }
    if (cmd === 'read' || cmd === 'replace' || cmd === 'doctor') {
      const { positional, flags } = parseArgs([sub, ...rest].filter(Boolean));
      if (cmd === 'read') return await cmdRead(positional, flags);
      if (cmd === 'replace') return await cmdReplace(positional, flags);
      return await cmdDoctor(positional, flags);
    }
    if (cmd === 'link' && sub === 'add') return await cmdLinkAdd(parseArgs(rest).positional);
    if (cmd === 'secrets' && sub === 'show') return await cmdSecretsShow(parseArgs(rest).positional);
    if (cmd === 'secrets' && sub === 'list') return await cmdSecretsList(parseArgs(rest).flags);
    help();
    if (cmd && cmd !== '--help' && cmd !== 'help') process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`[proof-docs] ${err.message}\n`);
    process.exitCode = 1;
  }
}

export { redact, slugFromPath, parseDocRef, assertConfiguredHost, chooseCredential, explainFailure, HttpError, buildHeaders };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
