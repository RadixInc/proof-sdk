import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';

export interface SourceBlockDescriptor {
  /** ProseMirror document position where this block starts. */
  from: number;
  /** ProseMirror document position where this block ends (exclusive). */
  to: number;
  /** This block's own markdown, serialized in isolation and trimmed. */
  text: string;
  /**
   * True when this block and the next are lists of matching ordered-ness —
   * without an explicit separator, reparsing would merge them back into one
   * list (CommonMark can't otherwise distinguish "two adjacent same-type
   * lists" from "one list with a gap").
   */
  needsListSeparatorAfter: boolean;
}

export interface SourceBlockDiff {
  fromBlockIndex: number;
  toBlockIndex: number;
  replacementText: string;
}

const LIST_SEPARATOR = '\n\n<!---->';
const BLOCK_SEPARATOR = '\n\n';
const LIST_NODE_TYPES = new Set(['bulletList', 'orderedList']);

export function buildSourceBlockDescriptors(
  doc: ProseMirrorNode,
  serializeNode: (node: ProseMirrorNode) => string
): SourceBlockDescriptor[] {
  const children: ProseMirrorNode[] = [];
  const descriptors: SourceBlockDescriptor[] = [];

  doc.forEach((node, offset) => {
    children.push(node);
    let text = '';
    try {
      text = serializeNode(node).trim();
    } catch (error) {
      console.error('[buildSourceBlockDescriptors] failed to serialize block', error);
    }
    descriptors.push({ from: offset, to: offset + node.nodeSize, text, needsListSeparatorAfter: false });
  });

  for (let i = 0; i < descriptors.length - 1; i++) {
    const a = children[i];
    const b = children[i + 1];
    if (LIST_NODE_TYPES.has(a.type.name) && a.type.name === b.type.name) {
      descriptors[i].needsListSeparatorAfter = true;
    }
  }

  return descriptors;
}

function blockText(descriptor: SourceBlockDescriptor): string {
  return descriptor.needsListSeparatorAfter ? descriptor.text + LIST_SEPARATOR : descriptor.text;
}

export function joinSourceBlocks(descriptors: SourceBlockDescriptor[]): string {
  return descriptors.map(blockText).join(BLOCK_SEPARATOR);
}

/**
 * Two-pointer prefix/suffix anchor diff: match unchanged blocks from both
 * ends of the descriptor array against the edited text; whatever's left in
 * the middle is the edited range. Block granularity (not char-level diff)
 * so the result maps directly onto a ProseMirror replaceWith range —
 * `replaceWith` doesn't require old/new node-count parity, so this also
 * transparently handles a block being split into two, or two blocks merging
 * into one.
 *
 * Known limitation: this is a two-anchor diff, not a full multi-block LCS.
 * Reordering two *unmodified* blocks (cut-paste) sweeps both into the
 * unmatched middle and reparses them — their content survives, but any
 * marks anchored to them do not, even though the text itself didn't change.
 */
export function diffSourceBlocks(descriptors: SourceBlockDescriptor[], newText: string): SourceBlockDiff | null {
  const n = descriptors.length;

  if (n === 0) {
    return newText.length > 0 ? { fromBlockIndex: 0, toBlockIndex: 0, replacementText: newText } : null;
  }

  // A block only counts as "safely matched" (and excluded from the replace
  // range) if its own text matches AND the boundary to its still-unconfirmed
  // neighbor is one of exactly two shapes: the untouched separator, or
  // *nothing at all* (the neighbor, and everything that used to separate it,
  // was cleanly deleted). Anything else at that boundary — e.g. a blank
  // line reduced to a single newline when merging two paragraphs — means the
  // relationship between the two blocks changed, even though this block's
  // own text is still present verbatim, and must fall into the replaced
  // range rather than being silently treated as unchanged.
  let i = 0;
  let cursor = 0;
  while (i < n) {
    const ownText = blockText(descriptors[i]);
    if (!newText.startsWith(ownText, cursor)) break;
    const afterOwnText = cursor + ownText.length;
    if (i === n - 1 || afterOwnText === newText.length || newText.startsWith(BLOCK_SEPARATOR, afterOwnText)) {
      cursor = i === n - 1 || afterOwnText === newText.length ? afterOwnText : afterOwnText + BLOCK_SEPARATOR.length;
      i++;
    } else {
      break;
    }
  }

  if (i === n && cursor === newText.length) return null; // fully matched — no-op

  let j = n - 1;
  let tail = newText.length;
  while (j >= i) {
    const ownText = blockText(descriptors[j]);
    const ownStart = tail - ownText.length;
    if (ownStart < cursor || newText.slice(ownStart, tail) !== ownText) break;
    if (j === 0 || ownStart === cursor) {
      tail = ownStart;
      j--;
    } else {
      const sepStart = ownStart - BLOCK_SEPARATOR.length;
      if (sepStart < cursor || newText.slice(sepStart, ownStart) !== BLOCK_SEPARATOR) break;
      tail = sepStart;
      j--;
    }
  }

  return { fromBlockIndex: i, toBlockIndex: j + 1, replacementText: newText.slice(cursor, tail) };
}
