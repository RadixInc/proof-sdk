import { isFinalizedMarkRegression } from '../bridge/marks-preservation';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    isFinalizedMarkRegression(
      { kind: 'insert', status: 'accepted', quote: 'x' },
      { kind: 'insert', status: 'pending', quote: 'x' },
    ) === true,
    'A stale client re-writing a finalized suggestion back to pending must be rejected',
  );

  assert(
    isFinalizedMarkRegression(
      { kind: 'replace', status: 'rejected', quote: 'x' },
      { kind: 'replace', status: 'pending', quote: 'x' },
    ) === true,
    'A stale client re-writing a rejected suggestion back to pending must be rejected',
  );

  assert(
    isFinalizedMarkRegression(
      { kind: 'insert', status: 'accepted', quote: 'x' },
      { kind: 'insert', status: 'accepted', quote: 'x', extra: 'field' },
    ) === false,
    'An idempotent echo of the same terminal status must be allowed through',
  );

  assert(
    isFinalizedMarkRegression(
      { kind: 'insert', status: 'pending', quote: 'x' },
      { kind: 'insert', status: 'accepted', quote: 'x' },
    ) === false,
    'A pending -> accepted transition (the normal finalize path) must be allowed',
  );

  assert(
    isFinalizedMarkRegression(undefined, { kind: 'insert', status: 'pending' }) === false,
    'A brand-new mark (no current value) is never a regression',
  );

  assert(
    isFinalizedMarkRegression(
      { kind: 'comment', by: 'human:test', text: 'hi' },
      { kind: 'comment', by: 'human:test', text: 'hi edited' },
    ) === false,
    'Non-terminal mark kinds (comments) are unaffected by this guard',
  );

  console.log('✓ finalized suggestion status cannot be regressed by a stale client write');
}

run();
