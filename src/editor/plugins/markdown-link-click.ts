import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { captureEvent } from '../../analytics/telemetry';

const markdownLinkClickKey = new PluginKey('markdown-link-click');
const AFFORDANCE_HORIZONTAL_GAP = 8;
const AFFORDANCE_VERTICAL_GAP = 8;
const AFFORDANCE_VIEWPORT_MARGIN = 10;
const AFFORDANCE_HIDE_DELAY_MS = 180;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const HAS_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const FALLBACK_BASE_URL = 'https://proofeditor.ai/';
const HOVER_LINK_CLASS = 'markdown-link-hover-target';

type ClosestCapable = {
  closest: (selector: string) => unknown;
};

type ParentElementCapable = {
  parentElement: unknown | null;
};

export type LinkTargetLike = {
  getAttribute: (name: string) => string | null;
};

export type LinkClickEventLike = Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'defaultPrevented'>;
export type LinkModifierEventLike = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>;

export type LinkActionCardState = {
  openLabel: string;
  modifierTitle: string;
  armed: boolean;
};

type LinkActionCardElements = {
  root: HTMLDivElement;
  openButton: HTMLButtonElement;
};

type LinkOpenTrigger = 'read_only_click' | 'modifier_click' | 'card_click';

type PluginViewWithDestroy = {
  update: (view: EditorView) => void;
  destroy: () => void;
};

type LinkElement = Element & LinkTargetLike;

const hoverControllers = new WeakMap<EditorView, MarkdownLinkHoverController>();

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac/i.test(userAgent);
}

function hasClosest(value: unknown): value is ClosestCapable {
  return typeof value === 'object'
    && value !== null
    && 'closest' in value
    && typeof (value as ClosestCapable).closest === 'function';
}

function hasParentElement(value: unknown): value is ParentElementCapable {
  return typeof value === 'object'
    && value !== null
    && 'parentElement' in value;
}

function hasGetAttribute(value: unknown): value is LinkTargetLike {
  return typeof value === 'object'
    && value !== null
    && 'getAttribute' in value
    && typeof (value as LinkTargetLike).getAttribute === 'function';
}

function isElementWithClassList(value: unknown): value is Element {
  return typeof value === 'object'
    && value !== null
    && 'classList' in value;
}

function getClosestSearchTarget(target: unknown): ClosestCapable | null {
  if (hasClosest(target)) return target;
  if (hasParentElement(target) && hasClosest(target.parentElement)) return target.parentElement;
  return null;
}

function resolveBaseUrl(baseHref?: string): URL {
  const runtimeBase = typeof window !== 'undefined' ? window.location?.href : undefined;
  const candidate = baseHref || runtimeBase || FALLBACK_BASE_URL;

  try {
    return new URL(candidate);
  } catch {
    return new URL(FALLBACK_BASE_URL);
  }
}

function extractLinkTarget(targetLike: unknown): LinkTargetLike | null {
  const target = getClosestSearchTarget(targetLike);
  if (!target) return null;

  if (target.closest('[data-mark-id]')) {
    return null;
  }

  const linkTarget = target.closest('a[href]');
  if (!hasGetAttribute(linkTarget)) return null;
  return linkTarget;
}

function asLinkElement(target: LinkTargetLike | null): LinkElement | null {
  if (!target || !isElementWithClassList(target)) return null;
  return target as LinkElement;
}

function getLinkProtocol(normalizedHref: string): string {
  try {
    return new URL(normalizedHref).protocol;
  } catch {
    return 'unknown';
  }
}

function openLinkInNewTab(rawHref: string, context: { editable: boolean; trigger: LinkOpenTrigger }): boolean {
  const normalizedHref = normalizeAndValidateHref(rawHref);
  if (!normalizedHref) {
    captureEvent('markdown_link_open_blocked', {
      reason: 'invalid_href',
      editable: context.editable,
      trigger: context.trigger,
    });
    return false;
  }

  const protocol = getLinkProtocol(normalizedHref);

  if (context.trigger === 'card_click') {
    captureEvent('markdown_link_open_clicked', {
      editable: context.editable,
      protocol,
    });
  }

  if (context.trigger === 'modifier_click') {
    captureEvent('markdown_link_open_modifier_click', {
      editable: context.editable,
      protocol,
    });
  }

  captureEvent('markdown_link_open_attempt', {
    editable: context.editable,
    protocol,
    trigger: context.trigger,
  });

  const opened = window.open(normalizedHref, '_blank', 'noopener,noreferrer');
  captureEvent(opened ? 'markdown_link_opened' : 'markdown_link_open_blocked', {
    reason: opened ? 'opened' : 'popup_blocked',
    editable: context.editable,
    protocol,
    trigger: context.trigger,
  });

  return Boolean(opened);
}

export function shouldOpenLinkForEvent(event: LinkClickEventLike, isEditable: boolean): boolean {
  if (event.button !== 0) return false;
  if (isEditable) {
    // ProseMirror/contenteditable often default-prevents clicks; modifier-click should still activate links.
    return isLinkModifierActive(event);
  }
  return !event.defaultPrevented;
}

export function isLinkModifierActive(event: LinkModifierEventLike): boolean {
  return Boolean(event.metaKey || event.ctrlKey);
}

export function getEditModeLinkCardState(isMac: boolean, modifierActive: boolean): LinkActionCardState {
  const modifier = isMac ? 'Cmd' : 'Ctrl';
  return {
    openLabel: 'Open link',
    modifierTitle: `${modifier}+click also works`,
    armed: modifierActive,
  };
}

export function normalizeAndValidateHref(rawHref: string, baseHref?: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  const baseUrl = resolveBaseUrl(baseHref);

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (trimmed.startsWith('#')) {
    return resolved.toString();
  }

  if (HAS_SCHEME_RE.test(trimmed)) {
    if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) return null;
    return resolved.toString();
  }

  if (resolved.origin !== baseUrl.origin) {
    return null;
  }

  return resolved.toString();
}

export function extractLinkTargetFromEvent(event: Pick<MouseEvent, 'target'>): LinkTargetLike | null {
  return extractLinkTarget(event.target);
}

class MarkdownLinkHoverController {
  private view: EditorView;
  private isMac = isMacPlatform();
  private cardElements: LinkActionCardElements | null = null;
  private activeLink: LinkElement | null = null;
  private activeRawHref: string | null = null;
  private hideTimer: number | null = null;
  private pointerOverCard = false;

  constructor(view: EditorView) {
    this.view = view;
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleViewportChange);
      window.addEventListener('scroll', this.handleViewportChange, true);
    }
  }

  updateView(view: EditorView): void {
    this.view = view;
    if (!view.editable) this.hideCard();
  }

  destroy(): void {
    this.clearHideTimer();
    this.hideCard();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleViewportChange);
      window.removeEventListener('scroll', this.handleViewportChange, true);
    }
    if (this.cardElements?.root.parentNode) {
      this.cardElements.root.parentNode.removeChild(this.cardElements.root);
    }
    this.cardElements = null;
  }

  dismissCard(): void {
    this.hideCard();
  }

  handleMouseMove(event: MouseEvent): void {
    if (!this.view.editable) {
      this.hideCard();
      return;
    }

    const link = this.getLinkFromTarget(event.target);
    if (link) {
      this.showCardForLink(link, isLinkModifierActive(event));
      return;
    }

    if (!this.pointerOverCard) {
      this.scheduleHide();
    }
  }

  handleMouseLeave(): void {
    if (!this.pointerOverCard) {
      this.scheduleHide();
    }
  }

  handleModifierEvent(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): void {
    if (!this.view.editable || !this.isCardVisible()) return;
    this.updateCardState(isLinkModifierActive(event));
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape' && this.isCardVisible()) {
      event.preventDefault();
      this.hideCard();
      return true;
    }
    return false;
  }

  private getLinkFromTarget(target: unknown): LinkElement | null {
    const link = asLinkElement(extractLinkTarget(target));
    if (!link) return null;
    if (!this.view.dom.contains(link)) return null;
    return link;
  }

  private ensureCardElements(): LinkActionCardElements | null {
    if (typeof document === 'undefined') return null;
    if (this.cardElements) return this.cardElements;

    const root = document.createElement('div');
    root.className = 'markdown-link-action-card';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Link actions');
    root.dataset.visible = 'false';
    root.dataset.armed = 'false';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'markdown-link-action-card-open';

    root.appendChild(openButton);

    root.addEventListener('pointerenter', this.handleCardPointerEnter);
    root.addEventListener('pointerleave', this.handleCardPointerLeave);
    root.addEventListener('focusin', this.handleCardFocusIn);
    root.addEventListener('focusout', this.handleCardFocusOut);
    root.addEventListener('keydown', this.handleCardKeyDown);
    root.addEventListener('mousedown', this.handleCardMouseDown);
    openButton.addEventListener('click', this.handleCardOpenClick);

    document.body.appendChild(root);

    this.cardElements = { root, openButton };

    return this.cardElements;
  }

  private updateCardState(modifierActive: boolean): void {
    const elements = this.cardElements;
    if (!elements) return;

    const state = getEditModeLinkCardState(this.isMac, modifierActive);
    elements.openButton.textContent = state.openLabel;
    elements.openButton.removeAttribute('title');
    elements.openButton.setAttribute('aria-label', `${state.openLabel}. ${state.modifierTitle}`);
    elements.root.dataset.armed = state.armed ? 'true' : 'false';
  }

  private showCardForLink(link: LinkElement, modifierActive: boolean): void {
    const href = link.getAttribute('href');
    if (!href) {
      if (!this.pointerOverCard) this.hideCard();
      return;
    }

    const wasVisible = this.isCardVisible();
    const changedLink = this.activeLink !== link;

    this.clearHideTimer();

    if (this.activeLink && this.activeLink !== link) {
      this.activeLink.classList.remove(HOVER_LINK_CLASS);
    }

    this.activeLink = link;
    this.activeRawHref = href;
    this.activeLink.classList.add(HOVER_LINK_CLASS);

    const elements = this.ensureCardElements();
    if (!elements) return;

    this.updateCardState(modifierActive);
    elements.root.dataset.visible = 'true';
    this.positionCard();

    if (!wasVisible || changedLink) {
      captureEvent('markdown_link_card_shown', {
        editable: this.view.editable,
        source: 'hover',
        valid_href: Boolean(normalizeAndValidateHref(href)),
      });
    }
  }

  private positionCard(): void {
    const elements = this.cardElements;
    if (!elements || !this.activeLink) return;

    const linkRect = this.activeLink.getBoundingClientRect();
    if ((linkRect.width === 0 && linkRect.height === 0) || Number.isNaN(linkRect.left) || Number.isNaN(linkRect.top)) {
      return;
    }

    const cardRect = elements.root.getBoundingClientRect();

    let left = linkRect.right + AFFORDANCE_HORIZONTAL_GAP;
    let top = linkRect.top + ((linkRect.height - cardRect.height) / 2);

    if (left + cardRect.width > window.innerWidth - AFFORDANCE_VIEWPORT_MARGIN) {
      left = linkRect.left - cardRect.width - AFFORDANCE_HORIZONTAL_GAP;
    }

    if (left < AFFORDANCE_VIEWPORT_MARGIN) {
      left = linkRect.left;
      top = linkRect.bottom + AFFORDANCE_VERTICAL_GAP;
    }

    const maxLeft = Math.max(AFFORDANCE_VIEWPORT_MARGIN, window.innerWidth - cardRect.width - AFFORDANCE_VIEWPORT_MARGIN);
    const maxTop = Math.max(AFFORDANCE_VIEWPORT_MARGIN, window.innerHeight - cardRect.height - AFFORDANCE_VIEWPORT_MARGIN);

    left = Math.min(Math.max(AFFORDANCE_VIEWPORT_MARGIN, left), maxLeft);
    top = Math.min(Math.max(AFFORDANCE_VIEWPORT_MARGIN, top), maxTop);

    elements.root.style.left = `${left}px`;
    elements.root.style.top = `${top}px`;
  }

  private isCardVisible(): boolean {
    return this.cardElements?.root.dataset.visible === 'true';
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private scheduleHide(delayMs = AFFORDANCE_HIDE_DELAY_MS): void {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (this.pointerOverCard) return;
      this.hideCard();
    }, delayMs);
  }

  private hideCard(): void {
    this.clearHideTimer();
    if (this.activeLink) {
      this.activeLink.classList.remove(HOVER_LINK_CLASS);
      this.activeLink = null;
    }
    this.activeRawHref = null;
    if (this.cardElements) {
      this.cardElements.root.dataset.visible = 'false';
      this.cardElements.root.dataset.armed = 'false';
    }
  }

  private openActiveLinkFromCard(): void {
    if (!this.activeRawHref) return;

    openLinkInNewTab(this.activeRawHref, {
      editable: this.view.editable,
      trigger: 'card_click',
    });

    this.hideCard();
    this.view.focus();
  }

  private handleViewportChange = (): void => {
    if (!this.isCardVisible()) return;
    this.positionCard();
  };

  private handleCardPointerEnter = (): void => {
    this.pointerOverCard = true;
    this.clearHideTimer();
  };

  private handleCardPointerLeave = (): void => {
    this.pointerOverCard = false;
    this.scheduleHide();
  };

  private handleCardFocusIn = (): void => {
    this.clearHideTimer();
  };

  private handleCardFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.cardElements?.root.contains(next)) {
      return;
    }
    this.scheduleHide();
  };

  private handleCardKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.hideCard();
    this.view.focus();
  };

  private handleCardMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handleCardOpenClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.openActiveLinkFromCard();
  };
}

function handleLinkClick(view: EditorView, event: MouseEvent): boolean {
  const link = extractLinkTargetFromEvent(event);
  if (!link) return false;

  const href = link.getAttribute('href');
  if (!href) return false;

  if (view.editable && event.button === 0 && !isLinkModifierActive(event)) {
    hoverControllers.get(view)?.dismissCard();
    captureEvent('markdown_link_open_blocked', {
      reason: 'modifier_required',
      editable: true,
    });
    return false;
  }

  const shouldOpen = shouldOpenLinkForEvent(event, view.editable);
  if (!shouldOpen) {
    const reason = event.button !== 0
      ? 'non_primary'
      : view.editable
        ? 'modifier_required'
        : 'default_prevented';

    captureEvent('markdown_link_open_blocked', {
      reason,
      editable: view.editable,
    });
    return false;
  }

  event.preventDefault();
  hoverControllers.get(view)?.dismissCard();

  const trigger: LinkOpenTrigger = view.editable ? 'modifier_click' : 'read_only_click';
  openLinkInNewTab(href, {
    editable: view.editable,
    trigger,
  });

  return true;
}

export function dismissLinkHoverCard(view: EditorView): void {
  hoverControllers.get(view)?.dismissCard();
}

export const markdownLinkClickPlugin = $prose(() => {
  return new Plugin({
    key: markdownLinkClickKey,
    view(view): PluginViewWithDestroy {
      const controller = new MarkdownLinkHoverController(view);
      hoverControllers.set(view, controller);
      return {
        update(nextView) {
          controller.updateView(nextView);
        },
        destroy() {
          hoverControllers.delete(view);
          controller.destroy();
        },
      };
    },
    props: {
      handleDOMEvents: {
        click(view, event) {
          if (!(event instanceof MouseEvent)) return false;
          return handleLinkClick(view, event);
        },
        mousemove(view, event) {
          if (!(event instanceof MouseEvent)) return false;
          hoverControllers.get(view)?.handleMouseMove(event);
          return false;
        },
        mouseleave(view, event) {
          if (!(event instanceof MouseEvent)) return false;
          hoverControllers.get(view)?.handleMouseLeave();
          return false;
        },
        keydown(view, event) {
          if (!(event instanceof KeyboardEvent)) return false;
          return hoverControllers.get(view)?.handleKeyDown(event) ?? false;
        },
        keyup(view, event) {
          if (!(event instanceof KeyboardEvent)) return false;
          hoverControllers.get(view)?.handleModifierEvent(event);
          return false;
        },
        blur(view) {
          hoverControllers.get(view)?.handleMouseLeave();
          return false;
        },
      },
    },
  });
});

export default markdownLinkClickPlugin;
