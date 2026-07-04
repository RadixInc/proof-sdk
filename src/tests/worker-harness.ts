/**
 * Shared harness for tests that boot the Worker under `wrangler dev`.
 *
 * CI-hardened: wrangler's output goes to a log file (piped stdio from
 * orphaned workerd children would hold the CI step open forever), the dev
 * server binds and is polled on 127.0.0.1 explicitly (Node 22 resolves
 * `localhost` to ::1 first), processes are spawned detached and killed as a
 * group, and boot failures print the wrangler log before exiting.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface WorkerHandle {
  base: string;
  stop(): void;
}

const logDir = mkdtempSync(join(tmpdir(), 'proof-worker-harness-'));
let logCounter = 0;

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid = process group
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export async function applyLocalMigrations(): Promise<void> {
  if (!existsSync('wrangler.jsonc')) {
    copyFileSync('wrangler.example.jsonc', 'wrangler.jsonc');
    console.log('created wrangler.jsonc from example');
  }
  const logPath = join(logDir, `migrations-${logCounter++}.log`);
  const fd = openSync(logPath, 'w');
  await new Promise<void>((resolve, reject) => {
    const mig = spawn(
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', 'proof-sdk', '--local'],
      {
        stdio: ['ignore', fd, fd],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      },
    );
    mig.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(readFileSync(logPath, 'utf8'));
        reject(new Error(`wrangler d1 migrations apply exited ${code}`));
      }
    });
  });
}

export async function startWorker(
  port: number,
  vars: Record<string, string>,
): Promise<WorkerHandle> {
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const logPath = join(logDir, `wrangler-dev-${port}-${logCounter++}.log`);
  const fd = openSync(logPath, 'w');
  const proc = spawn('npx', args, {
    stdio: ['ignore', fd, fd],
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  const stop = () => killTree(proc.pid);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break; // wrangler died — no point polling on
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { base, stop };
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  stop();
  console.error(`--- wrangler dev log (${logPath}) ---`);
  try {
    console.error(readFileSync(logPath, 'utf8'));
  } catch {
    /* no log */
  }
  throw new Error(`wrangler dev on :${port} did not become healthy`);
}

/** Hard exit on both success and failure so no orphan keeps CI hanging. */
export function finish(code: number): never {
  process.exit(code);
}
