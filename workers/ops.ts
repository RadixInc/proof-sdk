/**
 * Agent ops envelope parsing, authorization, and anchor resolution for
 * POST /documents/:slug/ops (issue #10), ported from upstream
 * server/document-ops.ts + server/document-engine.ts. Execution happens
 * inside DocumentDO (single serialized writer); this module is pure.
 */

import { canonicalizeAnchorTargetText } from '../src/shared/anchor-target-text';
import {
  buildAnchorRetrySteps,
  isFailClosedDuplicateHandlingEnabled,
  resolveAnchorTarget,
  stabilizeAnchorTarget,
} from './anchor-resolver';
import type { AnchorTarget } from './anchor-resolver';
import {
  canonicalizeVisibleTextWithMapping,
  mapVisibleSelectionToSourceRange,
  stripMarkdownWithMapping,
} from './visible-text';
import type { ResolvedRole } from './util';

export const DOCUMENT_OP_TYPES = [
  'comment.add',
  'comment.reply',
  'comment.resolve',
  'comment.unresolve',
  'suggestion.add',
  'suggestion.accept',
  'suggestion.reject',
  'rewrite.apply',
] as const;

export type DocumentOpType = (typeof DOCUMENT_OP_TYPES)[number];

/** All contract ops are implemented as of the writes slice (#11). */
export const IMPLEMENTED_OPS: ReadonlySet<DocumentOpType> = new Set(DOCUMENT_OP_TYPES);

/** Upstream MAX_REWRITE_CHANGES (server/canonical-document.ts). */
export const MAX_REWRITE_CHANGES = 1000;

export type RewriteChange = { find: string; replace: string };

/**
 * Port of upstream rewrite.apply payload validation: full-doc `content` XOR
 * partial `changes`, plus a required base revision (the DO checks it against
 * the live revision after catching the projection up).
 */
export function validateRewritePayload(
  payload: Record<string, unknown>,
):
  | {
      ok: true;
      mode: 'content' | 'changes';
      content?: string;
      changes?: RewriteChange[];
      baseRevision: number;
    }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const bad = (status: number, error: string, code?: string) => ({
    ok: false as const,
    status,
    body: { success: false, error, ...(code ? { code } : {}) },
  });
  const hasContent = typeof payload.content === 'string';
  const hasChanges = Array.isArray(payload.changes);
  if (hasContent === hasChanges) {
    return bad(400, 'Provide either content or changes (not both)');
  }
  const baseRaw = payload.baseRevision ?? payload.expectedRevision;
  const baseRevision = Number(baseRaw);
  if (!Number.isInteger(baseRevision) || baseRevision < 1) {
    return bad(400, 'rewrite.apply requires baseRevision (or expectedRevision)');
  }
  if (hasContent) {
    const content = payload.content as string;
    if (!content.trim()) return bad(400, 'markdown must not be empty', 'EMPTY_MARKDOWN');
    return { ok: true, mode: 'content', content, baseRevision };
  }
  const rawChanges = payload.changes as unknown[];
  if (rawChanges.length === 0) return bad(400, 'changes must not be empty');
  if (rawChanges.length > MAX_REWRITE_CHANGES) {
    return bad(400, `changes is limited to ${MAX_REWRITE_CHANGES} entries`);
  }
  const changes: RewriteChange[] = [];
  for (const raw of rawChanges) {
    if (
      !isRecord(raw) ||
      typeof raw.find !== 'string' ||
      raw.find.length === 0 ||
      typeof raw.replace !== 'string'
    ) {
      return bad(400, 'Each change requires a non-empty find and a string replace');
    }
    changes.push({ find: raw.find, replace: raw.replace });
  }
  return { ok: true, mode: 'changes', changes, baseRevision };
}

/** Port of upstream stripAuthoredMarks (server/canonical-document.ts). */
export function stripAuthoredMarks(
  marks: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [markId, mark] of Object.entries(marks)) {
    if (isRecord(mark) && mark.kind === 'authored') continue;
    filtered[markId] = mark;
  }
  return filtered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirrors the upstream engine's internal StoredMark (open shape). */
export type OpStoredMark = {
  kind?: string;
  by?: string;
  createdAt?: string;
  range?: { from: number; to: number };
  quote?: string;
  text?: string;
  thread?: unknown;
  threadId?: string;
  replies?: Array<{ by: string; text: string; at: string }>;
  resolved?: boolean;
  content?: string;
  status?: 'pending' | 'accepted' | 'rejected';
  target?: AnchorTarget;
  startRel?: string;
  endRel?: string;
  [key: string]: unknown;
};

/** Envelope: `type` preferred, `op` accepted; payload nested or inline. */
export function parseDocumentOp(
  raw: unknown,
):
  | { ok: true; op: DocumentOpType; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'Missing operation type' };
  const op =
    typeof raw.type === 'string' && raw.type
      ? raw.type
      : typeof raw.op === 'string'
        ? raw.op
        : '';
  if (!op) return { ok: false, error: 'Missing operation type' };
  if (!(DOCUMENT_OP_TYPES as readonly string[]).includes(op)) {
    return { ok: false, error: `Unsupported operation type: ${op}` };
  }
  const payload = isRecord(raw.payload) ? { ...raw.payload } : { ...raw };
  delete payload.type;
  delete payload.op;
  delete payload.payload;
  return { ok: true, op: op as DocumentOpType, payload };
}

/**
 * Upstream authorization matrix (server/document-ops.ts): comments and
 * suggestion.add need commenter+; accept/reject/rewrite need editor;
 * owner_bot passes everything including paused/revoked states.
 */
export function authorizeDocumentOp(
  op: DocumentOpType,
  role: ResolvedRole | null,
  shareState: string,
): { status: number; body: Record<string, unknown> } | null {
  if (shareState === 'DELETED') {
    return { status: 410, body: { success: false, error: 'Document deleted' } };
  }
  if (shareState === 'REVOKED' && role !== 'owner_bot') {
    return {
      status: 403,
      body: { success: false, error: 'Document access has been revoked' },
    };
  }
  if (!role) {
    return {
      status: 401,
      body: {
        success: false,
        error: 'Missing or invalid share token',
        code: 'UNAUTHORIZED',
        acceptedHeaders: [
          'x-share-token: <ACCESS_TOKEN>',
          'x-bridge-token: <OWNER_SECRET>',
          'Authorization: Bearer <TOKEN>',
        ],
      },
    };
  }
  if (role === 'owner_bot') return null;
  if (shareState !== 'ACTIVE') {
    return {
      status: 403,
      body: { success: false, error: 'Document is paused' },
    };
  }
  const needsEditor =
    op === 'suggestion.accept' || op === 'suggestion.reject' || op === 'rewrite.apply';
  const allowed = needsEditor
    ? role === 'editor'
    : role === 'commenter' || role === 'editor';
  if (!allowed) {
    return {
      status: 403,
      body: { success: false, error: 'Insufficient role for operation' },
    };
  }
  return null;
}

/** Port of the engine's parseAnchorTarget (server/document-engine.ts). */
export function parseAnchorTarget(
  raw: unknown,
): { ok: true; target: AnchorTarget } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'target must be an object' };
  if (typeof raw.anchor !== 'string' || !raw.anchor.length) {
    return { ok: false, error: 'target.anchor must be a non-empty string' };
  }
  const target: AnchorTarget = { anchor: raw.anchor };
  if (raw.mode !== undefined) {
    if (raw.mode !== 'exact' && raw.mode !== 'normalized' && raw.mode !== 'contextual') {
      return { ok: false, error: 'target.mode must be exact, normalized, or contextual' };
    }
    target.mode = raw.mode;
  }
  if (raw.occurrence !== undefined) {
    if (raw.occurrence === 'first' || raw.occurrence === 'last') {
      target.occurrence = raw.occurrence;
    } else if (Number.isInteger(raw.occurrence) && (raw.occurrence as number) >= 0) {
      target.occurrence = raw.occurrence as number;
    } else {
      return { ok: false, error: 'target.occurrence must be first, last, or a 0-based integer' };
    }
  }
  if (raw.contextBefore !== undefined) {
    if (typeof raw.contextBefore !== 'string') {
      return { ok: false, error: 'target.contextBefore must be a string' };
    }
    target.contextBefore = raw.contextBefore;
  }
  if (raw.contextAfter !== undefined) {
    if (typeof raw.contextAfter !== 'string') {
      return { ok: false, error: 'target.contextAfter must be a string' };
    }
    target.contextAfter = raw.contextAfter;
  }
  return { ok: true, target };
}

/** Legacy quote-only addressing: normalized match, first occurrence. */
export function buildImplicitLegacyTarget(anchor: string): AnchorTarget {
  return { anchor, mode: 'normalized', occurrence: 'first' };
}

/**
 * Addressing accepted by comment.add / suggestion.add: `target`,
 * `selector.target`, `quote`, or `selector.quote` (in that precedence).
 */
export function parseOpAddressing(
  payload: Record<string, unknown>,
  missingError: string,
): { ok: true; target: AnchorTarget } | { ok: false; error: string } {
  const selector = isRecord(payload.selector) ? payload.selector : {};
  const rawTarget = payload.target ?? selector.target;
  if (rawTarget !== undefined) return parseAnchorTarget(rawTarget);
  const quote =
    typeof payload.quote === 'string' && payload.quote.length > 0
      ? payload.quote
      : typeof selector.quote === 'string' && selector.quote.length > 0
        ? selector.quote
        : null;
  if (!quote) return { ok: false, error: missingError };
  return { ok: true, target: buildImplicitLegacyTarget(quote) };
}

export interface ResolvedOpAnchor {
  selection: { sourceStart: number; sourceEnd: number };
  stabilizedTarget: AnchorTarget;
  logicalSource: string;
}

/**
 * Port of the engine's resolveMutationAnchor: resolve against canonical
 * visible text, then map the match back to markdown source offsets.
 */
export function resolveOpAnchor(
  markdown: string,
  target: AnchorTarget,
  notFoundError: string,
):
  | { ok: true; anchor: ResolvedOpAnchor }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const normalizedTarget = canonicalizeAnchorTargetText(target);
  const { stripped, map } = stripMarkdownWithMapping(markdown);
  const canonical = canonicalizeVisibleTextWithMapping(stripped, map);
  const resolved = resolveAnchorTarget(canonical.text, normalizedTarget, {
    defaultMode: normalizedTarget.mode,
    failClosedDuplicates: isFailClosedDuplicateHandlingEnabled(),
    stripAuthoredSpans: false,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        code: resolved.code,
        error:
          resolved.code === 'ANCHOR_AMBIGUOUS'
            ? 'Anchor target is ambiguous in current markdown'
            : notFoundError,
        details: {
          candidateCount: resolved.candidateCount,
          mode: resolved.mode,
          remapUsed: resolved.remapUsed,
        },
        nextSteps: buildAnchorRetrySteps(resolved.code),
      },
    };
  }
  const mapped = mapVisibleSelectionToSourceRange(
    markdown,
    canonical.map,
    resolved.selection.sourceStart,
    resolved.selection.sourceEnd,
  );
  if (!mapped) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        code: 'ANCHOR_NOT_FOUND',
        error: notFoundError,
        details: { candidateCount: 0, mode: resolved.mode, remapUsed: resolved.remapUsed },
        nextSteps: buildAnchorRetrySteps('ANCHOR_NOT_FOUND'),
      },
    };
  }
  const stabilized = stabilizeAnchorTarget(canonical.text, normalizedTarget, resolved);
  return {
    ok: true,
    anchor: {
      selection: mapped,
      stabilizedTarget: stabilized,
      logicalSource: canonical.text,
    },
  };
}
