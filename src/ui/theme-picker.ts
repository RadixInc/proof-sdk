export type Theme = 'default' | 'whitey';
export type Appearance = 'light' | 'dark';

export interface ThemePickerOptions {
  defaultTheme?: Theme;
  defaultAppearance?: Appearance;
  container?: HTMLElement;
  onChange?: (theme: Theme) => void;
  onAppearanceChange?: (appearance: Appearance) => void;
}

export class ThemePicker {
  private currentTheme: Theme;
  private currentAppearance: Appearance;
  private container: HTMLElement | null;
  private onChange?: (theme: Theme) => void;
  private onAppearanceChange?: (appearance: Appearance) => void;

  constructor(options: ThemePickerOptions = {}) {
    this.currentTheme = options.defaultTheme || this.loadSavedTheme();
    this.currentAppearance = options.defaultAppearance || this.loadSavedAppearance();
    this.container = options.container || null;
    this.onChange = options.onChange;
    this.onAppearanceChange = options.onAppearanceChange;
  }

  init(): void {
    this.applyTheme(this.currentTheme);
    this.applyAppearance(this.currentAppearance);
    this.render();
  }

  private loadSavedTheme(): Theme {
    const saved = localStorage.getItem('proof-theme');
    if (saved === 'whitey' || saved === 'default') {
      return saved;
    }
    return 'default';
  }

  private saveTheme(theme: Theme): void {
    localStorage.setItem('proof-theme', theme);
  }

  private loadSavedAppearance(): Appearance {
    const saved = localStorage.getItem('proof-appearance');
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
    return 'light';
  }

  private saveAppearance(appearance: Appearance): void {
    localStorage.setItem('proof-appearance', appearance);
  }

  setTheme(theme: Theme): void {
    this.currentTheme = theme;
    this.applyTheme(theme);
    this.saveTheme(theme);
    this.updateUI();
    this.onChange?.(theme);
  }

  getTheme(): Theme {
    return this.currentTheme;
  }

  setAppearance(appearance: Appearance): void {
    this.currentAppearance = appearance;
    this.applyAppearance(appearance);
    this.saveAppearance(appearance);
    this.updateUI();
    this.onAppearanceChange?.(appearance);
  }

  getAppearance(): Appearance {
    return this.currentAppearance;
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }

  private applyAppearance(appearance: Appearance): void {
    document.documentElement.setAttribute('data-appearance', appearance);
  }

  /**
   * Bottom-right appearance/reading switcher:
   *   READ  [Sans | Serif]   THEME  [Light | Dark]
   * Styled by the .proof-switcher rules in index.html.
   */
  private render(): void {
    if (document.querySelector('.proof-switcher')) return;

    const switcher = document.createElement('div');
    switcher.className = 'proof-switcher';
    switcher.innerHTML = `
      <span class="proof-switcher-lab">Read</span>
      <div class="proof-switcher-seg" role="group" aria-label="Reading style">
        <button type="button" data-set-theme="default" aria-label="Sans-serif reading style">Sans</button>
        <button type="button" data-set-theme="whitey" aria-label="Serif reading style">Serif</button>
      </div>
      <span class="proof-switcher-lab">Theme</span>
      <div class="proof-switcher-seg" role="group" aria-label="Appearance">
        <button type="button" data-set-appearance="light" aria-label="Light appearance">Light</button>
        <button type="button" data-set-appearance="dark" aria-label="Dark appearance">Dark</button>
      </div>
    `;

    switcher.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button) return;
      const theme = button.getAttribute('data-set-theme');
      const appearance = button.getAttribute('data-set-appearance');
      if (theme === 'default' || theme === 'whitey') this.setTheme(theme);
      if (appearance === 'light' || appearance === 'dark') this.setAppearance(appearance);
    });

    document.body.appendChild(switcher);
    this.updateUI();
  }

  private updateUI(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.proof-switcher button')) {
      const theme = button.getAttribute('data-set-theme');
      const appearance = button.getAttribute('data-set-appearance');
      const on = theme ? theme === this.currentTheme : appearance === this.currentAppearance;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }
}

// Singleton for global access
let themePickerInstance: ThemePicker | null = null;

export function initThemePicker(options?: ThemePickerOptions): ThemePicker {
  if (!themePickerInstance) {
    themePickerInstance = new ThemePicker(options);
    themePickerInstance.init();
  }
  return themePickerInstance;
}

export function getThemePicker(): ThemePicker | null {
  return themePickerInstance;
}
