/**
 * Visible-text anchor addressing, ported verbatim from the upstream Node
 * engine (server/document-engine.ts) so agent op anchor resolution matches
 * upstream behavior exactly (issue #10). Pipeline: markdown ->
 * stripMarkdownWithMapping (visible text + source index map) ->
 * canonicalizeVisibleTextWithMapping -> resolveAnchorTarget (anchor-resolver)
 * -> map the selection back to markdown source offsets. Also carries the
 * accepted-suggestion markdown splice used by suggestion.accept (issue #11).
 */

import { stripMarkdownVisibleText } from '../src/shared/anchor-target-text';
import type { StoredMark } from '../src/formats/marks';

export function normalizeQuote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export function parseRelativeCharOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^char:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

export function stripMarkdownWithMapping(markdown: string): { stripped: string; map: number[] } {
  const source = markdown ?? '';
  const strippedChars: string[] = [];
  const map: number[] = [];

  const pushChar = (ch: string, srcIdx: number): void => {
    strippedChars.push(ch);
    map.push(srcIdx);
  };

  const emitSpan = (start: number, end: number): void => {
    for (let idx = start; idx < end; idx += 1) {
      pushChar(source[idx], idx);
    }
  };

  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

  // Bounded indexOf to prevent O(n²) on pathological input (e.g. 10k unmatched '[').
  // Set to 50k to handle large fenced code blocks while still bounding adversarial input.
  // This is a fallback path — primary quote matching uses exact substring search.
  const MAX_DELIMITER_SEARCH = 50_000;
  const boundedIndexOf = (needle: string, from: number): number => {
    const limit = Math.min(source.length, from + MAX_DELIMITER_SEARCH);
    const idx = source.slice(from, limit).indexOf(needle);
    return idx !== -1 ? from + idx : -1;
  };

  let i = 0;
  while (i < source.length) {
    // Line-level stripping (headings, lists, blockquotes, task lists, HR)
    if (i === 0 || source[i - 1] === '\n') {
      const lineEndIdx = source.indexOf('\n', i);
      const lineEnd = lineEndIdx === -1 ? source.length : lineEndIdx;
      const lineSlice = source.slice(i, lineEnd);
      if (/^[ \t]*([-*_]){3,}[ \t]*$/.test(lineSlice)) {
        i = lineEnd;
        continue;
      }

      let cursor = i;

      // Blockquote prefix
      let j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (j < lineEnd && source[j] === '>') {
        j += 1;
        if (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // Heading prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      let hashCount = 0;
      while (j < lineEnd && source[j] === '#' && hashCount < 6) {
        hashCount += 1;
        j += 1;
      }
      if (hashCount > 0 && j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
        while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // List prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      let listMatched = false;
      if (j < lineEnd && (source[j] === '-' || source[j] === '*' || source[j] === '+')) {
        j += 1;
        listMatched = true;
      } else if (j < lineEnd && /[0-9]/.test(source[j])) {
        let k = j;
        while (k < lineEnd && /[0-9]/.test(source[k])) k += 1;
        if (k < lineEnd && source[k] === '.') {
          j = k + 1;
          listMatched = true;
        }
      }
      if (listMatched && j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
        while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
        cursor = j;
      }

      // Task list prefix
      j = cursor;
      while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
      if (
        j + 2 < lineEnd
        && source[j] === '['
        && (source[j + 1] === ' ' || source[j + 1] === 'x' || source[j + 1] === 'X')
        && source[j + 2] === ']'
      ) {
        j += 3;
        if (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) {
          while (j < lineEnd && (source[j] === ' ' || source[j] === '\t')) j += 1;
          cursor = j;
        }
      }

      if (cursor !== i) {
        i = cursor;
        continue;
      }
    }

    // HTML tag handling (only check when we see '<' to keep the loop O(n))
    if (source[i] === '<') {
      // Block-level HTML tags become a block separator in the visible-text domain.
      const blockTagMatch = source.slice(i).match(/^<\/?(?:p|br|div|li)\b[^>]*>/i);
      if (blockTagMatch) {
        const matchLen = blockTagMatch[0].length;
        const closingIdx = i + matchLen - 1;
        pushChar('\n', closingIdx);
        i += matchLen;
        continue;
      }

      // Remove remaining HTML tags.
      const anyTagMatch = source.slice(i).match(/^<[^>]+>/);
      if (anyTagMatch) {
        i += anyTagMatch[0].length;
        continue;
      }
    }

    // Images: ![alt](url)
    if (source[i] === '!' && source[i + 1] === '[') {
      const closeBracket = boundedIndexOf(']', i + 2);
      if (closeBracket !== -1 && source[closeBracket + 1] === '(') {
        const closeParen = boundedIndexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          emitSpan(i + 2, closeBracket);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Links: [text](url) or [text][ref]
    if (source[i] === '[') {
      const closeBracket = boundedIndexOf(']', i + 1);
      if (closeBracket !== -1 && closeBracket > i + 1) {
        const nextChar = source[closeBracket + 1];
        if (nextChar === '(') {
          const closeParen = boundedIndexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            emitSpan(i + 1, closeBracket);
            i = closeParen + 1;
            continue;
          }
        } else if (nextChar === '[') {
          const closeRef = boundedIndexOf(']', closeBracket + 2);
          if (closeRef !== -1) {
            emitSpan(i + 1, closeBracket);
            i = closeRef + 1;
            continue;
          }
        }
      }
    }

    // Fenced code blocks
    if (source.startsWith('```', i) || source.startsWith('~~~', i)) {
      const fence = source.startsWith('```', i) ? '```' : '~~~';
      const closeIdx = boundedIndexOf(fence, i + fence.length);
      if (closeIdx !== -1) {
        emitSpan(i + fence.length, closeIdx);
        i = closeIdx + fence.length;
        continue;
      }
    }

    // Inline code markers
    if (source[i] === '`') {
      const closeIdx = boundedIndexOf('`', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }

    // Emphasis/strike markers
    if (source.startsWith('***', i)) {
      const closeIdx = boundedIndexOf('***', i + 3);
      if (closeIdx !== -1 && !source.slice(i + 3, closeIdx).includes('*')) {
        emitSpan(i + 3, closeIdx);
        i = closeIdx + 3;
        continue;
      }
    }
    if (source.startsWith('___', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('___', i + 3);
      const next = closeIdx !== -1 ? source[closeIdx + 3] : '';
      if (
        closeIdx !== -1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 3, closeIdx).includes('_')
      ) {
        emitSpan(i + 3, closeIdx);
        i = closeIdx + 3;
        continue;
      }
    }
    if (source.startsWith('**', i)) {
      const closeIdx = boundedIndexOf('**', i + 2);
      if (closeIdx !== -1 && !source.slice(i + 2, closeIdx).includes('*')) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source.startsWith('__', i)) {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('__', i + 2);
      const next = closeIdx !== -1 ? source[closeIdx + 2] : '';
      if (
        closeIdx !== -1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 2, closeIdx).includes('_')
      ) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source.startsWith('~~', i)) {
      const closeIdx = boundedIndexOf('~~', i + 2);
      if (closeIdx !== -1 && !source.slice(i + 2, closeIdx).includes('~')) {
        emitSpan(i + 2, closeIdx);
        i = closeIdx + 2;
        continue;
      }
    }
    if (source[i] === '*') {
      const closeIdx = boundedIndexOf('*', i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && !source.slice(i + 1, closeIdx).includes('*')) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }
    if (source[i] === '_') {
      const prev = i > 0 ? source[i - 1] : '';
      const closeIdx = boundedIndexOf('_', i + 1);
      const next = closeIdx !== -1 ? source[closeIdx + 1] : '';
      if (
        closeIdx !== -1
        && closeIdx > i + 1
        && !isWordChar(prev)
        && !isWordChar(next)
        && !source.slice(i + 1, closeIdx).includes('_')
      ) {
        emitSpan(i + 1, closeIdx);
        i = closeIdx + 1;
        continue;
      }
    }

    // Unescape markdown escapes.
    if (source[i] === '\\' && i + 1 < source.length) {
      const nextChar = source[i + 1];
      if (/^[\\`*_{}\[\]()#+\-.!]$/.test(nextChar)) {
        pushChar(nextChar, i + 1);
        i += 2;
        continue;
      }
    }

    pushChar(source[i], i);
    i += 1;
  }

  return { stripped: strippedChars.join(''), map };
}

export function normalizeMarkdownForQuote(markdown: string): string {
  return normalizeQuote(stripMarkdownVisibleText(markdown));
}

export function canonicalizeVisibleTextWithMapping(
  stripped: string,
  map: number[],
): { text: string; map: number[] } {
  const textChars: string[] = [];
  const canonicalMap: number[] = [];
  let index = 0;

  while (index < stripped.length) {
    const ch = stripped[index];
    if (ch === '\r') {
      index += 1;
      continue;
    }

    if (ch === '\n') {
      let end = index + 1;
      while (end < stripped.length) {
        const next = stripped[end];
        if (next === '\r') {
          end += 1;
          continue;
        }
        if (next === '\n' || next === ' ' || next === '\t') {
          end += 1;
          continue;
        }
        break;
      }

      while (textChars.length > 0 && (textChars[textChars.length - 1] === ' ' || textChars[textChars.length - 1] === '\t')) {
        textChars.pop();
        canonicalMap.pop();
      }
      if (textChars.length > 0 && end < stripped.length && textChars[textChars.length - 1] !== '\n') {
        textChars.push('\n');
        canonicalMap.push(map[Math.min(end - 1, map.length - 1)] ?? map[index] ?? 0);
      }
      index = end;
      continue;
    }

    if ((ch === ' ' || ch === '\t') && textChars[textChars.length - 1] === '\n') {
      index += 1;
      continue;
    }

    textChars.push(ch);
    canonicalMap.push(map[index] ?? 0);
    index += 1;
  }

  return {
    text: textChars.join(''),
    map: canonicalMap,
  };
}


export function expandMarkdownSpan(markdown: string, start: number, end: number): { start: number; end: number } {
  const pairs = [
    { open: '***', close: '***' },
    { open: '___', close: '___' },
    { open: '**', close: '**' },
    { open: '__', close: '__' },
    { open: '~~', close: '~~' },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
    { open: '`', close: '`' },
  ];
  let expandedStart = start;
  let expandedEnd = end;
  const linePrefixLength = (lineText: string): number => {
    let idx = 0;
    while (idx < lineText.length && (lineText[idx] === ' ' || lineText[idx] === '\t')) idx += 1;
    let hasPrefix = false;
    while (idx < lineText.length && lineText[idx] === '>') {
      idx += 1;
      if (lineText[idx] === ' ' || lineText[idx] === '\t') idx += 1;
      hasPrefix = true;
    }

    const headingMatch = lineText.slice(idx).match(/^#{1,6}[ \t]+/);
    if (headingMatch) return idx + headingMatch[0].length;

    const listMatch = lineText.slice(idx).match(/^(?:[-*+]|\d+\.)[ \t]+/);
    if (listMatch) {
      idx += listMatch[0].length;
      const taskMatch = lineText.slice(idx).match(/^\[(?: |x|X)\][ \t]+/);
      if (taskMatch) idx += taskMatch[0].length;
      return idx;
    }

    return hasPrefix ? idx : 0;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of pairs) {
      const openStart = expandedStart - pair.open.length;
      const closeEnd = expandedEnd + pair.close.length;
      if (openStart < 0 || closeEnd > markdown.length) continue;
      if (markdown.slice(openStart, expandedStart) !== pair.open) continue;
      if (markdown.slice(expandedEnd, closeEnd) !== pair.close) continue;
      expandedStart = openStart;
      expandedEnd = closeEnd;
      changed = true;
      break;
    }
  }

  const htmlTagLookahead = 30;
  const htmlTagLookbehind = 50;
  changed = true;
  while (changed) {
    changed = false;
    const afterSlice = markdown.slice(expandedEnd, expandedEnd + htmlTagLookahead);
    const closeMatch = afterSlice.match(/^<\/([a-zA-Z][a-zA-Z0-9]*)>/);
    if (closeMatch) {
      const tagName = closeMatch[1];
      const beforeSlice = markdown.slice(Math.max(0, expandedStart - htmlTagLookbehind), expandedStart);
      const openPattern = new RegExp(`<${tagName}\\b[^>]*>$`);
      const openMatch = beforeSlice.match(openPattern);
      if (openMatch) {
        expandedStart -= openMatch[0].length;
        expandedEnd += closeMatch[0].length;
        changed = true;
      }
    }
  }

  const beforeChar = expandedStart > 0 ? markdown[expandedStart - 1] : '';
  const beforeChar2 = expandedStart > 1 ? markdown[expandedStart - 2] : '';
  if (beforeChar === '[') {
    const afterSlice = markdown.slice(expandedEnd);
    const linkClose = afterSlice.match(/^\]\([^)]*\)/);
    const refClose = afterSlice.match(/^\]\[[^\]]*\]/);
    if (linkClose) {
      const imgPrefix = beforeChar2 === '!' ? 2 : 1;
      expandedStart -= imgPrefix;
      expandedEnd += linkClose[0].length;
    } else if (refClose) {
      const imgPrefix = beforeChar2 === '!' ? 2 : 1;
      expandedStart -= imgPrefix;
      expandedEnd += refClose[0].length;
    }
  }

  const lineStart = markdown.lastIndexOf('\n', expandedStart - 1) + 1;
  const lineEndIdx = markdown.indexOf('\n', expandedEnd);
  const lineEnd = lineEndIdx === -1 ? markdown.length : lineEndIdx;
  if (expandedEnd === lineEnd) {
    const lineText = markdown.slice(lineStart, lineEnd);
    const prefixLen = linePrefixLength(lineText);
    if (prefixLen > 0 && expandedStart === lineStart + prefixLen) {
      expandedStart = lineStart;
    }
  }

  return { start: expandedStart, end: expandedEnd };
}

type QuoteAnchor = {
  rawStart: number;
  rawEnd: number;
  strippedStart: number;
  strippedEnd: number;
};

export function mapVisibleSelectionToSourceRange(
  markdown: string,
  map: number[],
  startOffset: number,
  endOffset: number,
): { sourceStart: number; sourceEnd: number } | null {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return null;
  if (startOffset < 0 || endOffset > map.length) return null;
  const sourceStart = map[startOffset];
  const sourceEndInclusive = map[endOffset - 1];
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEndInclusive)) return null;
  return {
    sourceStart: Math.max(0, Math.min(markdown.length, sourceStart)),
    sourceEnd: Math.max(0, Math.min(markdown.length, sourceEndInclusive + 1)),
  };
}

export function buildAcceptedSuggestionMarkdownFromSelection(
  markdown: string,
  suggestion: StoredMark,
  selection: { sourceStart: number; sourceEnd: number },
): string {
  const rawStart = Math.min(selection.sourceStart, selection.sourceEnd);
  const rawEnd = Math.max(selection.sourceStart, selection.sourceEnd);
  const span = expandMarkdownSpan(markdown, rawStart, rawEnd);

  if (suggestion.kind === 'insert') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    return `${markdown.slice(0, span.end)}${content}${markdown.slice(span.end)}`;
  }

  if (suggestion.kind === 'delete') {
    return `${markdown.slice(0, span.start)}${markdown.slice(span.end)}`;
  }

  if (suggestion.kind === 'replace') {
    const content = typeof suggestion.content === 'string' ? suggestion.content : '';
    const prefix = markdown.slice(span.start, rawStart);
    const suffix = markdown.slice(rawEnd, span.end);
    return `${markdown.slice(0, span.start)}${prefix}${content}${suffix}${markdown.slice(span.end)}`;
  }

  return markdown;
}


export function buildStoredSelectionMetadata(
  markdown: string,
  selection: { sourceStart: number; sourceEnd: number },
  fallbackQuote: string,
): { quote: string; startRel?: string; endRel?: string } {
  const normalizedFallback = normalizeQuote(fallbackQuote);
  const { stripped, map } = stripMarkdownWithMapping(markdown);
  const canonical = canonicalizeVisibleTextWithMapping(stripped, map);
  const sourceStart = Math.min(selection.sourceStart, selection.sourceEnd);
  const sourceEnd = Math.max(selection.sourceStart, selection.sourceEnd);
  let startOffset = -1;
  let endOffset = -1;

  for (let i = 0; i < canonical.map.length; i += 1) {
    const sourceIndex = canonical.map[i];
    if (sourceIndex < sourceStart || sourceIndex >= sourceEnd) continue;
    if (startOffset < 0) startOffset = i;
    endOffset = i + 1;
  }

  if (startOffset >= 0 && endOffset > startOffset) {
    const quote = normalizeQuote(canonical.text.slice(startOffset, endOffset)) || normalizedFallback;
    return {
      quote,
      startRel: `char:${startOffset}`,
      endRel: `char:${endOffset}`,
    };
  }

  return { quote: normalizedFallback };
}
