import { getHeadlessMilkdownParser } from '../../workers/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const parser = await getHeadlessMilkdownParser();

  const tableMarkdown = [
    '# Table Test',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
  ].join('\n');

  const tableDoc = parser.parseMarkdown(tableMarkdown);
  const tableJson = JSON.stringify(tableDoc.toJSON());
  assert(
    tableJson.includes('"table"'),
    'Expected headless parser to parse GFM tables into a table node (ensure remark-gfm is enabled).',
  );

  // Ensure code blocks with proof metadata do not crash in Node (no global atob/btoa).
  // Base64 for "[]"
  const proofMeta = 'proof:W10=';
  const codeMarkdown = [
    '# Code Block Meta Test',
    '',
    '```js ' + proofMeta,
    'console.log(\"ok\")',
    '```',
    '',
  ].join('\n');

  const codeDoc = parser.parseMarkdown(codeMarkdown);
  assert(
    typeof codeDoc.textContent === 'string' && codeDoc.textContent.includes('console.log'),
    'Expected headless parser to parse fenced code blocks with proof meta.',
  );

  console.log('✓ headless Milkdown parser supports GFM tables + Node-safe proof meta decoding');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

