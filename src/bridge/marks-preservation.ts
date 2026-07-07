export function shouldPreserveMissingLocalMark(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'authored') return false;
  // Suggestions should not be force-preserved locally when missing from server marks;
  // accept/reject removes them and stale preservation causes reappearance loops.
  if (kind === 'insert' || kind === 'delete' || kind === 'replace') return false;
  const status = (value as { status?: unknown }).status;
  if (status === 'accepted' || status === 'rejected') return false;
  return true;
}

function readStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as { status?: unknown }).status;
}

/**
 * True when writing `incoming` over `current` would regress a mark out of a
 * terminal state — e.g. a stale client's cached "pending" snapshot clobbering
 * a suggestion the server (or another client) already accepted/rejected.
 * Once a mark is accepted/rejected that decision is final; only another write
 * carrying the same terminal status (an idempotent echo) may proceed.
 */
export function isFinalizedMarkRegression(current: unknown, incoming: unknown): boolean {
  const currentStatus = readStatus(current);
  if (currentStatus !== 'accepted' && currentStatus !== 'rejected') return false;
  return readStatus(incoming) !== currentStatus;
}
