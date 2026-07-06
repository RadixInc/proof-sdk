/**
 * Bug-report bridge (issue #16): files GitHub issues via plain fetch to a
 * deployer-configured repository. Replaces the legacy Node subsystem
 * (evidence bundles, AppSignal correlation, follow-up threads) with the
 * durable core of the contract: an agent or human submits a report, an
 * issue lands in the configured repo. No hardcoded organization values —
 * owner/repo/token are environment config.
 */

import type { Identity } from './access';

export interface BugReportEnv {
  PROOF_GITHUB_ISSUES_OWNER?: string;
  PROOF_GITHUB_ISSUES_REPO?: string;
  PROOF_GITHUB_ISSUES_TOKEN?: string;
  /** Test seam: override the GitHub API origin. */
  PROOF_GITHUB_API_BASE?: string;
}

const REPORT_TYPES = new Set(['bug', 'performance', 'ux']);
const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low']);

export function getBugReportSpec(): Record<string, unknown> {
  return {
    requiredFields: ['summary'],
    optionalFields: ['description', 'expected', 'actual', 'slug', 'reportType', 'severity'],
    reportTypes: [...REPORT_TYPES],
    severities: [...SEVERITIES],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleBugReportSubmit(
  request: Request,
  env: BugReportEnv,
  identity: Identity,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (isRecord(parsed)) body = parsed;
  } catch {
    // validated below
  }
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    return Response.json(
      {
        success: false,
        code: 'BUG_REPORT_INCOMPLETE',
        missingFields: ['summary'],
        suggestedQuestions: ['What happened, in one sentence?'],
      },
      { status: 422 },
    );
  }
  const reportType =
    typeof body.reportType === 'string' && REPORT_TYPES.has(body.reportType)
      ? body.reportType
      : 'bug';
  const severity =
    typeof body.severity === 'string' && SEVERITIES.has(body.severity)
      ? body.severity
      : 'medium';

  const owner = env.PROOF_GITHUB_ISSUES_OWNER?.trim();
  const repo = env.PROOF_GITHUB_ISSUES_REPO?.trim();
  const token = env.PROOF_GITHUB_ISSUES_TOKEN?.trim();
  if (!owner || !repo || !token) {
    return Response.json(
      {
        success: false,
        code: 'BUG_REPORTS_NOT_CONFIGURED',
        error:
          'Set PROOF_GITHUB_ISSUES_OWNER/REPO and the PROOF_GITHUB_ISSUES_TOKEN secret to enable bug reports',
      },
      { status: 503 },
    );
  }

  const reporter =
    identity.kind === 'human' ? identity.email : `agent:${identity.serviceTokenId}`;
  const section = (label: string, value: unknown): string =>
    typeof value === 'string' && value.trim() ? `\n\n**${label}**\n\n${value.trim()}` : '';
  const issueBody =
    `Reported via the in-product bug bridge by \`${reporter}\`.` +
    section('Description', body.description) +
    section('Expected', body.expected) +
    section('Actual', body.actual) +
    (typeof body.slug === 'string' && body.slug.trim()
      ? `\n\n**Document**: \`${body.slug.trim()}\``
      : '') +
    `\n\n**Severity**: ${severity}`;

  const apiBase = env.PROOF_GITHUB_API_BASE?.trim() || 'https://api.github.com';
  let response: Response;
  try {
    response = await fetch(`${apiBase}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'proof-sdk-bug-bridge',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `[${reportType}] ${summary}`,
        body: issueBody,
        labels: [reportType, `severity:${severity}`],
      }),
    });
  } catch (err) {
    return Response.json(
      { success: false, code: 'BUG_REPORT_FILING_FAILED', error: String(err) },
      { status: 502 },
    );
  }
  if (!response.ok) {
    return Response.json(
      {
        success: false,
        code: 'BUG_REPORT_FILING_FAILED',
        error: `GitHub responded ${response.status}`,
      },
      { status: 502 },
    );
  }
  const issue = (await response.json()) as Record<string, unknown>;
  return Response.json({
    success: true,
    issueNumber: issue.number ?? null,
    issueUrl: issue.html_url ?? null,
  });
}
