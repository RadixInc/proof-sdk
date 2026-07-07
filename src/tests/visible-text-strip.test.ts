/**
 * Unit coverage for stripSuggestionSpansById (workers/visible-text.ts):
 * dissolving a finalized suggestion's anchor span from projected markdown
 * while keeping inner content — including nested spans (authored provenance
 * inside the anchor), multiple spans sharing one mark id (marks split across
 * text nodes), and unbalanced markup left intact rather than corrupted.
 */

import assert from 'node:assert/strict';
import { stripSuggestionSpansById } from '../../workers/visible-text';

const ID = 'cf8c792b-4300-4b3c-8d26-82ce0c10154a';
const OTHER = 'aebb2035-351a-4563-ae7f-bda8f1167237';

function span(id: string, inner: string, kind = 'replace'): string {
  return `<span data-proof="suggestion" data-id="${id}" data-by="ai:agent" data-kind="${kind}">${inner}</span>`;
}

// Simple case: span dissolves, inner text kept.
assert.equal(
  stripSuggestionSpansById(`before ${span(ID, 'kept text')} after`, ID),
  'before kept text after',
  'simple span should dissolve to inner text',
);

// Nested spans inside the anchor (authored provenance) survive intact.
const nested = `<span data-proof="authored" data-proof-id="authored:human:a@example.com:1-4" data-by="human:a@example.com">-af</span>`;
assert.equal(
  stripSuggestionSpansById(`x ${span(ID, nested)} y`, ID),
  `x ${nested} y`,
  'nested inner spans should be preserved',
);

// Multiple spans with the same id (mark split across text nodes) all dissolve.
assert.equal(
  stripSuggestionSpansById(`${span(ID, 'one')} mid ${span(ID, 'two')}`, ID),
  'one mid two',
  'every span carrying the id should dissolve',
);

// Other ids untouched.
const other = span(OTHER, 'other');
assert.equal(
  stripSuggestionSpansById(`${span(ID, 'mine')} ${other}`, ID),
  `mine ${other}`,
  'spans with other ids must remain',
);

// No match: markdown unchanged (and no infinite loop).
const plain = 'no spans here';
assert.equal(stripSuggestionSpansById(plain, ID), plain, 'no-op without a match');

// Unbalanced markup: skip rather than corrupt.
const unbalanced = `<span data-proof="suggestion" data-id="${ID}" data-kind="replace">never closed`;
assert.equal(
  stripSuggestionSpansById(unbalanced, ID),
  unbalanced,
  'unbalanced markup should be left intact',
);

// Empty id: no-op.
assert.equal(stripSuggestionSpansById(`x ${span(ID, 'y')} z`, ''), `x ${span(ID, 'y')} z`);

console.log('visible-text-strip: all assertions passed');
