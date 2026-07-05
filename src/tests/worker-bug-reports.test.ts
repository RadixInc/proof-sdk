/**
 * Bug-report bridge verification (issue #16).
 *
 * Boots the Worker against a local mock of the GitHub issues API and
 * asserts plain-fetch filing to the env-configured owner/repo/token,
 * validation (422), and the unconfigured 503.
 */

import { createServer } from 'node:http';
import { applyLocalMigrations, finish, startWorker } from './worker-harness';

const PORT = 8986;
const MOCK_PORT = 8987;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = { 'x-dev-agent': 'bug-test', 'content-type': 'application/json' };

let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    console.error(`FAIL: ${name}`, detail ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${name}`);
}

async function main() {
  await applyLocalMigrations();

  const filed: Array<{ path: string; auth: string | undefined; body: any }> = [];
  const mock = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      filed.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: JSON.parse(data || '{}'),
      });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ number: 4242, html_url: 'https://github.example/issues/4242' }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  const worker = await startWorker(PORT, {
    PROOF_DEV_MODE: '1',
    PROOF_GITHUB_ISSUES_OWNER: 'your-org',
    PROOF_GITHUB_ISSUES_REPO: 'your-repo',
    PROOF_GITHUB_ISSUES_TOKEN: 'test-token',
    PROOF_GITHUB_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  });
  try {
    const spec = await fetch(`${BASE}/api/agent/bug-reports/spec`, { headers: AGENT });
    const specBody = (await spec.json()) as Record<string, any>;
    ok('bug-reports/spec -> 200 with required fields', spec.status === 200 && specBody.requiredFields.includes('summary'));

    const incomplete = await fetch(`${BASE}/api/agent/bug-reports`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ description: 'no summary' }),
    });
    const incompleteBody = (await incomplete.json()) as Record<string, any>;
    ok('missing summary -> 422 BUG_REPORT_INCOMPLETE', incomplete.status === 422 && incompleteBody.code === 'BUG_REPORT_INCOMPLETE' && incompleteBody.missingFields.includes('summary'));

    const report = await fetch(`${BASE}/api/agent/bug-reports`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({
        summary: 'Editor loses cursor on paste',
        description: 'Steps: paste a table…',
        severity: 'high',
        reportType: 'bug',
        slug: 'abc12345',
      }),
    });
    const reportBody = (await report.json()) as Record<string, any>;
    ok('report files -> 200 + issue number/url', report.status === 200 && reportBody.issueNumber === 4242 && String(reportBody.issueUrl).includes('4242'), reportBody);
    ok('filed to the configured owner/repo', filed[0].path === '/repos/your-org/your-repo/issues', filed[0]?.path);
    ok('used the configured token', filed[0].auth === 'Bearer test-token');
    ok('issue carries title, labels, and reporter', String(filed[0].body.title).includes('[bug] Editor loses cursor') && filed[0].body.labels.includes('severity:high') && String(filed[0].body.body).includes('agent:bug-test'), filed[0].body);

    console.log(`\nworker-bug-reports: ${passed} assertions passed`);
  } finally {
    worker.stop();
    mock.close();
  }

  // Unconfigured -> 503 (fresh worker without the env).
  const bare = await startWorker(PORT + 2, { PROOF_DEV_MODE: '1' });
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 2}/api/agent/bug-reports`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ summary: 'test' }),
    });
    ok('unconfigured -> 503 BUG_REPORTS_NOT_CONFIGURED', res.status === 503 && ((await res.json()) as any).code === 'BUG_REPORTS_NOT_CONFIGURED');
    console.log(`\nworker-bug-reports (unconfigured): ${passed} assertions passed total`);
  } finally {
    bare.stop();
  }
}

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error(err);
    finish(1);
  });
