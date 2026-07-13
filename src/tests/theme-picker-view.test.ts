import { ThemePicker, type DocView } from '../ui/theme-picker';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${String(expected)}, got: ${String(actual)}`);
  }
}

class MockStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

class MockButton {
  private attrs: Record<string, string>;
  private classes = new Set<string>();
  classList = {
    toggle: (cls: string, on: boolean) => {
      if (on) this.classes.add(cls);
      else this.classes.delete(cls);
    },
  };

  constructor(attrs: Record<string, string>) {
    this.attrs = attrs;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  hasClass(cls: string): boolean {
    return this.classes.has(cls);
  }
}

function installMockDom(buttons: MockButton[]): { attrs: Record<string, string> } {
  const documentElement = {
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };

  (globalThis as any).localStorage = new MockStorage();
  (globalThis as any).document = {
    documentElement,
    body: { appendChild: () => {} },
    querySelector: () => null,
    querySelectorAll: () => buttons,
    createElement: () => ({ addEventListener: () => {} }),
  };

  return documentElement;
}

function makeSwitcherButtons(): {
  buttons: MockButton[];
  source: MockButton;
  rendered: MockButton;
  sansTheme: MockButton;
  lightAppearance: MockButton;
} {
  const source = new MockButton({ 'data-set-view': 'source' });
  const rendered = new MockButton({ 'data-set-view': 'rendered' });
  const sansTheme = new MockButton({ 'data-set-theme': 'default' });
  const lightAppearance = new MockButton({ 'data-set-appearance': 'light' });
  return { buttons: [source, rendered, sansTheme, lightAppearance], source, rendered, sansTheme, lightAppearance };
}

function testDefaultsToRenderedWithNoSavedPreference(): void {
  installMockDom([]);
  const picker = new ThemePicker();
  assertEqual(picker.getView(), 'rendered', 'A fresh ThemePicker with no persisted preference should default to rendered');
}

function testGarbageLocalStorageValueFallsBackToRendered(): void {
  const documentElement = installMockDom([]);
  void documentElement;
  (globalThis as any).localStorage.setItem('proof-view', 'not-a-real-view');
  const picker = new ThemePicker();
  assertEqual(picker.getView(), 'rendered', 'An unrecognized persisted value should fall back to rendered, not be trusted as-is');
}

function testConstructorRestoresPersistedSourceView(): void {
  installMockDom([]);
  (globalThis as any).localStorage.setItem('proof-view', 'source');
  const picker = new ThemePicker();
  assertEqual(picker.getView(), 'source', 'A persisted source preference should be restored on construction');
}

function testSetViewPersistsAppliesAttributeAndFiresCallback(): void {
  const documentElement = installMockDom([]);
  let callbackValue: DocView | null = null;
  const picker = new ThemePicker({ onViewChange: (view) => { callbackValue = view; } });

  picker.setView('source');

  assertEqual(picker.getView(), 'source', 'getView should reflect the just-set view');
  assertEqual(documentElement.attrs['data-view'], 'source', 'setView should apply data-view on document.documentElement, since CSS keys off this attribute to swap #editor/.proof-source');
  assertEqual((globalThis as any).localStorage.getItem('proof-view'), 'source', 'setView should persist the choice under the proof-view localStorage key');
  assertEqual(callbackValue as DocView | null, 'source', 'setView should invoke onViewChange with the new view');

  picker.setView('rendered');
  assertEqual(documentElement.attrs['data-view'], 'rendered', 'Switching back to rendered should update the data-view attribute again');
  assertEqual(callbackValue as DocView | null, 'rendered', 'onViewChange should fire again with rendered');
}

function testUpdateUiTogglesOnlyTheMatchingViewButtonWithoutCrossWiringThemeOrAppearance(): void {
  const { buttons, source, rendered, sansTheme, lightAppearance } = makeSwitcherButtons();
  installMockDom(buttons);
  const picker = new ThemePicker();

  picker.setView('source');

  assert(source.hasClass('on'), 'The Source button should be marked on after setView("source")');
  assertEqual(source.getAttribute('aria-pressed'), 'true', 'The Source button should report aria-pressed=true');
  assert(!rendered.hasClass('on'), 'The Rendered button should not be marked on while source is active');
  assertEqual(rendered.getAttribute('aria-pressed'), 'false', 'The Rendered button should report aria-pressed=false');

  // Theme/appearance buttons must be evaluated against currentTheme/currentAppearance,
  // never against currentView, even though updateUI() shares one loop over all buttons.
  assert(sansTheme.hasClass('on'), 'The default Sans theme button should stay on (its own default state) — a view change must not cross-wire into the theme button');
  assert(lightAppearance.hasClass('on'), 'The default Light appearance button should stay on — a view change must not cross-wire into the appearance button');
}

function run(): void {
  testDefaultsToRenderedWithNoSavedPreference();
  testGarbageLocalStorageValueFallsBackToRendered();
  testConstructorRestoresPersistedSourceView();
  testSetViewPersistsAppliesAttributeAndFiresCallback();
  testUpdateUiTogglesOnlyTheMatchingViewButtonWithoutCrossWiringThemeOrAppearance();
  console.log('✓ ThemePicker Source/Rendered view state machine');
}

run();
