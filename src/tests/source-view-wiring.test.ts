import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, '../editor/index.ts'), 'utf8');

assert(
  source.includes('const themePicker = initThemePicker({ onViewChange: (view) => this.setDocView(view) });'),
  'Expected initThemePicker to be wired with an onViewChange callback that drives setDocView',
);

assert(
  source.includes('closeActivePopover(editorView);'),
  'Expected setDocView to close the comment/suggestion popover on entering Source view, since it is anchored to document.body and would otherwise dangle once #editor is hidden',
);

assert(
  source.includes('dismissLinkHoverCard(editorView);'),
  'Expected setDocView to dismiss the markdown-link hover card on entering Source view, for the same document.body-anchoring reason',
);

assert(
  source.includes('hideThinkingPanel();'),
  'Expected setDocView to close the agent thinking panel on entering Source view',
);

assert(
  source.includes('if (wasSourceActive && !this.isSourceViewActive) {') && source.includes('this.commitSourcePanelEdit();'),
  'Expected setDocView to commit any pending Source-panel edit when switching away from Source view, so leaving the view never silently drops in-progress work',
);

assert(
  source.includes('if (this.isSourceViewActive) this.refreshSourcePanel();'),
  'Expected scheduleContentSync to live-refresh the Source panel (rebuilding block descriptors from the live doc) while it is active',
);

assert(
  source.includes('view.dispatch(tr);\n      if (this.isSourceViewActive) this.refreshSourcePanel();'),
  'Expected loadDocument to refresh the Source panel AFTER the document replace actually dispatches — refreshing before that ' +
    'point would read the doc\'s stale pre-load state, since refreshSourcePanel now derives its content from the live document rather than a passed-in string',
);

assert(
  source.includes("textarea.value = 'Loading…';")
    && source.includes('const awaitingInitialLoad = (this.isCliMode || this.isShareMode) && !this.hasTrackedDocumentOpened;'),
  'Expected refreshSourcePanel to only show the loading placeholder while CLI/share mode has an async load in flight — ' +
    'gating on hasTrackedDocumentOpened alone left the bare local/scratch editor (no CLI file, no share slug, which never ' +
    'calls loadDocument at all) stuck on "Loading…" forever, even though its empty live doc IS the final state',
);

assert(
  source.includes('if (this.sourcePanelDirty || document.activeElement === textarea) return;'),
  'Expected refreshSourcePanel to skip overwriting the textarea while a local edit is dirty or focused, so a remote ' +
    'collaborator\'s update cannot clobber in-progress local typing',
);

assert(
  source.includes('const diff = diffSourceBlocks(fresh, textarea.value);'),
  'Expected commitSourcePanelEdit to diff against block descriptors rebuilt from the LIVE doc at commit time (not a cached ' +
    'snapshot), so remote edits that landed mid-session are correctly reflected for every block the reader did not touch',
);

assert(
  source.includes('const result = this.replaceRange(from, to, diff.replacementText, getCurrentActor());'),
  'Expected commitSourcePanelEdit to pass getCurrentActor() as the author to replaceRange — programmatic dispatch never ' +
    'triggers authoredTrackerPlugin (DOM-input-only), so omitting the author would silently drop provenance that a typed ' +
    'Rendered-view edit would have gotten for free',
);

assert(
  source.includes('try {') && source.includes('parser(diff.replacementText);') && source.includes('} catch {'),
  'Expected commitSourcePanelEdit to silently skip (not error) when the edited text does not parse yet — normal typing ' +
    'routinely passes through momentarily-invalid markdown (e.g. an unclosed code fence)',
);

console.log('✓ Source/Rendered view toggle wiring (including editable-commit path)');
