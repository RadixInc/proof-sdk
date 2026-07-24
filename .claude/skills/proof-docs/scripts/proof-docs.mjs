#!/usr/bin/env node
// Deterministic transport for the proof-docs skill: config resolution, two-layer auth,
// and secret persistence live here so the agent never has to hand-roll them (or the
// full ownerSecret/accessToken) inside the conversation transcript.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'proof-docs');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
const SECRET_FIELDS = ['ownerSecret', 'accessToken'];

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
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
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

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_FIELDS.includes(k) ? truncate(v) : redact(v);
    }
    return out;
  }
  return value;
}

function sanitizeHost(host) {
  return host.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function secretsFile(host, slug) {
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

function loadSecrets(host, slug) {
  const file = secretsFile(host, slug);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No stored credentials for slug "${slug}" at ${host} (looked in ${file}). ` +
      'Pass --token explicitly if this document was created outside this skill.'
    );
  }
  return readJson(file);
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

async function doFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(body)}`);
  }
  return body;
}

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

async function resolveToken(config, flags) {
  if (flags.token) return flags.token;
  if (!flags.slug) return undefined;
  const stored = loadSecrets(config.host, flags.slug);
  const as = flags.as || 'link';
  return as === 'owner' ? stored.ownerSecret : stored.accessToken;
}

async function cmdCall(positional, flags) {
  const config = loadConfig();
  const host = requireHost(config);
  const [method, reqPath] = positional;
  if (!method || !reqPath) throw new Error('call requires <METHOD> <path>, e.g. call GET /documents/abc123xy/state');

  const token = await resolveToken(config, flags);
  const extraHeaders = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (flags.header) {
    const headerList = Array.isArray(flags.header) ? flags.header : [flags.header];
    for (const h of headerList) {
      const idx = h.indexOf(':');
      if (idx > 0) extraHeaders[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }

  let requestBody;
  if (flags['body-file']) requestBody = fs.readFileSync(flags['body-file'], 'utf8');
  else if (flags.body) requestBody = flags.body;

  if (requestBody !== undefined) extraHeaders['Content-Type'] = extraHeaders['Content-Type'] || 'application/json';
  if (method.toUpperCase() !== 'GET' && !extraHeaders['Idempotency-Key']) {
    extraHeaders['Idempotency-Key'] = crypto.randomUUID();
  }

  const headers = buildHeaders(config, extraHeaders);
  const url = `${host}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`;
  const result = await doFetch(url, { method: method.toUpperCase(), headers, body: requestBody });
  print(redact(result));
}

async function cmdSecretsShow(positional, flags) {
  const config = loadConfig();
  const host = requireHost(config);
  const [slug] = positional;
  if (!slug) throw new Error('secrets show requires <slug>');
  const stored = loadSecrets(host, slug);
  print({ ...redact(stored), secretsFile: secretsFile(host, slug) });
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

  call <METHOD> <path> [--slug <slug>] [--as owner|link] [--token <token>]
       [--body <json>] [--body-file <path>] [--header "Name: value"]
      Generic authenticated request for anything else in the deployment's
      agent contract (state, ops, events poll/ack, etc). Resolves the token
      from the local secrets store by --slug unless --token is given
      explicitly. Read GET <host>/agent-docs for the exact path/body shape
      of each endpoint — that deployment-served reference is authoritative,
      not any file bundled with this skill.

  secrets show <slug>
      Prints the stored (redacted) credential record and its file path for a slug.

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
    if (cmd === 'secrets' && sub === 'show') {
      const { positional } = parseArgs(rest);
      return await cmdSecretsShow(positional, {});
    }
    help();
    if (cmd && cmd !== '--help' && cmd !== 'help') process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`[proof-docs] ${err.message}\n`);
    process.exitCode = 1;
  }
}

main();
