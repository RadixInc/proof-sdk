/** Types for headless-engine.js (see that file for why this boundary exists). */

import type { Node as ProseMirrorNode, Schema } from '@milkdown/prose/model';

export interface HeadlessMilkdownParser {
  schema: Schema;
  parseMarkdown: (markdown: string) => ProseMirrorNode;
}

export interface MarkdownParseWithFallbackResult {
  doc: ProseMirrorNode | null;
  mode: 'original' | 'strip_html_lines' | 'strip_html_tags' | 'failed';
  error: unknown;
}

export function getHeadlessMilkdownParser(): Promise<HeadlessMilkdownParser>;
export function parseMarkdownWithHtmlFallback(
  parser: HeadlessMilkdownParser,
  markdown: string,
): MarkdownParseWithFallbackResult;
export function serializeMarkdown(doc: ProseMirrorNode): Promise<string>;
