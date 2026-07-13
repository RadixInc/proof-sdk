import { Schema } from '@milkdown/kit/prose/model';
import {
  buildSourceBlockDescriptors,
  diffSourceBlocks,
  joinSourceBlocks,
  type SourceBlockDescriptor,
} from '../editor/source-block-diff';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

// --- diffSourceBlocks / joinSourceBlocks: pure descriptor-array tests ---

function block(text: string, needsListSeparatorAfter = false): SourceBlockDescriptor {
  // from/to are irrelevant to diffSourceBlocks/joinSourceBlocks themselves;
  // callers (commitSourcePanelEdit) use them, tested separately below.
  return { from: 0, to: 0, text, needsListSeparatorAfter };
}

function testJoinSourceBlocksBasic(): void {
  const joined = joinSourceBlocks([block('# Heading'), block('Some text.'), block('More text.')]);
  assertEqual(joined, '# Heading\n\nSome text.\n\nMore text.', 'Blocks should join with a blank-line separator');
}

function testJoinSourceBlocksInsertsListSeparator(): void {
  const joined = joinSourceBlocks([block('- a'), block('- b', true), block('- c')]);
  assertEqual(
    joined,
    '- a\n\n- b\n\n<!---->\n\n- c',
    'A block flagged needsListSeparatorAfter should get an explicit <!----> separator before the next block',
  );
}

function testDiffNoOpReturnsNull(): void {
  const descriptors = [block('# Heading'), block('Some text.')];
  const result = diffSourceBlocks(descriptors, joinSourceBlocks(descriptors));
  assert(result === null, 'Unchanged text should diff to null (no-op)');
}

function testDiffEditWithinOneBlock(): void {
  const descriptors = [block('# Heading'), block('Some text.'), block('More text.')];
  const edited = '# Heading\n\nSome EDITED text.\n\nMore text.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'An edit should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'Only the middle block should be identified as changed (from)');
  assertEqual(diff!.toBlockIndex, 2, 'Only the middle block should be identified as changed (to)');
  assertEqual(diff!.replacementText, 'Some EDITED text.', 'The replacement text should be exactly the edited block');
}

function testDiffInsertNewBlock(): void {
  const descriptors = [block('# Heading'), block('Some text.')];
  const edited = '# Heading\n\nA new paragraph.\n\nSome text.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'An insertion should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'Insertion point should be right after the unchanged first block');
  assertEqual(diff!.toBlockIndex, 1, 'A pure insertion should have an empty (zero-width) block range');
  assertEqual(diff!.replacementText, 'A new paragraph.', 'The replacement text should be exactly the inserted block');
}

function testDiffDeleteBlock(): void {
  const descriptors = [block('# Heading'), block('Delete me.'), block('Keep me.')];
  const edited = '# Heading\n\nKeep me.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'A deletion should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'The deleted block should be identified as the changed range (from)');
  assertEqual(diff!.toBlockIndex, 2, 'The deleted block should be identified as the changed range (to)');
  assertEqual(diff!.replacementText, '', 'A pure deletion should have empty replacement text');
}

function testDiffMergeTwoBlocks(): void {
  // User deletes the blank line separating two paragraphs, merging them into one.
  const descriptors = [block('# Heading'), block('First.'), block('Second.')];
  const edited = '# Heading\n\nFirst.\nSecond.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'A merge should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'Both original blocks should be swept into the changed range (from)');
  assertEqual(diff!.toBlockIndex, 3, 'Both original blocks should be swept into the changed range (to)');
  assertEqual(diff!.replacementText, 'First.\nSecond.', 'The replacement text should be the merged content');
}

function testDiffSplitOneBlockIntoTwo(): void {
  // User inserts a blank line in the middle of one paragraph, splitting it into two.
  const descriptors = [block('# Heading'), block('First. Second.')];
  const edited = '# Heading\n\nFirst.\n\nSecond.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'A split should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'The original single block should be identified as the changed range (from)');
  assertEqual(diff!.toBlockIndex, 2, 'The original single block should be identified as the changed range (to)');
  assertEqual(diff!.replacementText, 'First.\n\nSecond.', 'The replacement text should be the two split blocks');
}

function testDiffEditWithinAdjacentSameTypeLists(): void {
  const descriptors = [block('- a1'), block('- b1', true), block('- c1')];
  const original = joinSourceBlocks(descriptors);
  const edited = original.replace('- b1', '- b1 EDITED');
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'Editing inside one of two adjacent same-type lists should not diff to null');
  assertEqual(diff!.fromBlockIndex, 1, 'Only the edited (middle) list should be identified as changed (from)');
  assertEqual(diff!.toBlockIndex, 2, 'Only the edited (middle) list should be identified as changed (to)');
  // Includes the trailing <!----> list-disambiguator baked into this block's
  // own text (needsListSeparatorAfter) — harmless noise for the reparse, but
  // real content of the replaced range, not the join separator between blocks.
  assertEqual(
    diff!.replacementText,
    '- b1 EDITED\n\n<!---->',
    'The replacement text should be the edited list plus its own trailing list-separator marker',
  );
}

function testDiffDeleteTrailingBlock(): void {
  // Deleting the LAST block removes the only thing the preceding block's
  // separator relationship could be checked against — the preceding block's
  // own text is still exactly present, just now at the very end of the text.
  const descriptors = [block('# Heading'), block('Keep me.'), block('Delete me (last).')];
  const edited = '# Heading\n\nKeep me.';
  const diff = diffSourceBlocks(descriptors, edited);
  assert(diff !== null, 'Deleting the trailing block should not diff to null');
  assertEqual(diff!.fromBlockIndex, 2, 'Only the deleted trailing block should be identified as changed (from)');
  assertEqual(diff!.toBlockIndex, 3, 'Only the deleted trailing block should be identified as changed (to)');
  assertEqual(diff!.replacementText, '', 'A pure trailing deletion should have empty replacement text');
}

// --- buildSourceBlockDescriptors: real prosemirror-model schema ---

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    bulletList: { content: 'listItem+', group: 'block', toDOM: () => ['ul', 0] },
    orderedList: { content: 'listItem+', group: 'block', toDOM: () => ['ol', 0] },
    listItem: { content: 'paragraph+', toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
});

function serializeNodeForTest(node: import('@milkdown/kit/prose/model').Node): string {
  if (node.type.name === 'paragraph') return node.textContent;
  if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
    const items: string[] = [];
    node.forEach((item) => items.push(`- ${item.textContent}`));
    return items.join('\n');
  }
  return node.textContent;
}

function testBuildSourceBlockDescriptorsPositionsAndText(): void {
  const p1 = testSchema.nodes.paragraph.create(null, testSchema.text('Hello'));
  const p2 = testSchema.nodes.paragraph.create(null, testSchema.text('World'));
  const doc = testSchema.nodes.doc.create(null, [p1, p2]);

  const descriptors = buildSourceBlockDescriptors(doc, serializeNodeForTest);

  assertEqual(descriptors.length, 2, 'Should produce one descriptor per top-level block');
  assertEqual(descriptors[0].from, 0, 'First block should start at position 0');
  assertEqual(descriptors[0].to, p1.nodeSize, 'First block should end at its own nodeSize');
  assertEqual(descriptors[1].from, p1.nodeSize, 'Second block should start right after the first (siblings are contiguous)');
  assertEqual(descriptors[0].text, 'Hello', 'First block text should be its serialized content');
  assertEqual(descriptors[1].text, 'World', 'Second block text should be its serialized content');
}

function testBuildSourceBlockDescriptorsFlagsAdjacentSameTypeLists(): void {
  const li = (text: string) => testSchema.nodes.listItem.create(null, testSchema.nodes.paragraph.create(null, testSchema.text(text)));
  const bulletA = testSchema.nodes.bulletList.create(null, [li('a')]);
  const bulletB = testSchema.nodes.bulletList.create(null, [li('b')]);
  const ordered = testSchema.nodes.orderedList.create(null, [li('c')]);
  const doc = testSchema.nodes.doc.create(null, [bulletA, bulletB, ordered]);

  const descriptors = buildSourceBlockDescriptors(doc, serializeNodeForTest);

  assertEqual(descriptors[0].needsListSeparatorAfter, true, 'Two adjacent bulletLists should require a separator');
  assertEqual(descriptors[1].needsListSeparatorAfter, false, 'A bulletList followed by an orderedList should not require a separator (different types)');
}

function run(): void {
  testJoinSourceBlocksBasic();
  testJoinSourceBlocksInsertsListSeparator();
  testDiffNoOpReturnsNull();
  testDiffEditWithinOneBlock();
  testDiffInsertNewBlock();
  testDiffDeleteBlock();
  testDiffMergeTwoBlocks();
  testDiffSplitOneBlockIntoTwo();
  testDiffEditWithinAdjacentSameTypeLists();
  testDiffDeleteTrailingBlock();
  testBuildSourceBlockDescriptorsPositionsAndText();
  testBuildSourceBlockDescriptorsFlagsAdjacentSameTypeLists();
  console.log('✓ source block diff (Source view edit commit granularity)');
}

run();
