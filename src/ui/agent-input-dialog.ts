/**
 * Agent Input Dialog
 *
 * A floating dialog for invoking the agent with a custom prompt.
 * Appears near the selection when Cmd+Shift+P is pressed.
 */

import type { AgentInputContext, AgentInputCallbacks } from '../editor/plugins/keybindings';

// ============================================================================
// Types
// ============================================================================

interface DialogState {
  isOpen: boolean;
  context: AgentInputContext | null;
  callbacks: AgentInputCallbacks | null;
  element: HTMLElement | null;
}

// ============================================================================
// State
// ============================================================================

const state: DialogState = {
  isOpen: false,
  context: null,
  callbacks: null,
  element: null,
};

// ============================================================================
// Dialog Element
// ============================================================================

function createDialogElement(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.className = 'agent-input-dialog';
  dialog.innerHTML = `
    <div class="agent-input-dialog-content">
      <div class="agent-input-dialog-header">
        <span class="agent-input-dialog-title">Ask Proof</span>
        <button class="agent-input-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="agent-input-dialog-body">
        <div class="agent-input-dialog-selection"></div>
        <textarea
          class="agent-input-dialog-textarea"
          placeholder="What would you like Proof to do?"
          rows="3"
        ></textarea>
      </div>
      <div class="agent-input-dialog-footer">
        <div class="agent-input-dialog-quick-actions">
          <button class="agent-input-quick-action" data-action="fix-grammar">Fix grammar</button>
          <button class="agent-input-quick-action" data-action="improve-clarity">Improve clarity</button>
          <button class="agent-input-quick-action" data-action="make-shorter">Make shorter</button>
        </div>
        <div class="agent-input-dialog-actions">
          <button class="agent-input-dialog-cancel">Cancel</button>
          <button class="agent-input-dialog-submit">Send</button>
        </div>
      </div>
    </div>
  `;

  // Add styles
  const style = document.createElement('style');
  style.textContent = `
    .agent-input-dialog {
      position: fixed;
      z-index: 10000;
      background: var(--surface, #ffffff);
      border: 1px solid var(--border, #e5e5ec);
      border-radius: var(--r-md, 8px);
      box-shadow: var(--sh-lg, 0 14px 38px rgba(20,20,45,.14), 0 2px 8px rgba(20,20,45,.06));
      width: 400px;
      max-width: calc(100vw - 32px);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      opacity: 0;
      transform: translateY(-8px);
      transition: opacity 0.15s ease, transform 0.15s ease;
    }

    .agent-input-dialog.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .agent-input-dialog-content {
      display: flex;
      flex-direction: column;
    }

    .agent-input-dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border, #e5e5ec);
    }

    .agent-input-dialog-title {
      font-weight: 600;
      color: var(--text, #191a23);
    }

    .agent-input-dialog-close {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: var(--text-muted, #797d90);
      padding: 0;
      line-height: 1;
    }

    .agent-input-dialog-close:hover {
      color: var(--text, #191a23);
    }

    .agent-input-dialog-body {
      padding: 16px;
    }

    .agent-input-dialog-selection {
      background: var(--surface-2, #f4f4f8);
      border-radius: var(--r-xs, 4px);
      padding: 8px 12px;
      margin-bottom: 12px;
      font-size: 13px;
      color: var(--text-muted, #797d90);
      max-height: 80px;
      overflow-y: auto;
      white-space: pre-wrap;
      display: none;
    }

    .agent-input-dialog-selection.has-selection {
      display: block;
    }

    .agent-input-dialog-textarea {
      width: 100%;
      border: 1px solid var(--border, #e5e5ec);
      border-radius: var(--r-sm, 6px);
      padding: 10px 12px;
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      min-height: 60px;
      color: var(--text, #191a23);
      background: var(--surface, #ffffff);
    }

    .agent-input-dialog-textarea:focus {
      outline: none;
      border-color: var(--link, #2563eb);
      box-shadow: 0 0 0 3px var(--focus, rgba(37, 99, 235, 0.32));
    }

    .agent-input-dialog-footer {
      padding: 12px 16px;
      border-top: 1px solid var(--border, #e5e5ec);
    }

    .agent-input-dialog-quick-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .agent-input-quick-action {
      background: var(--surface-2, #f4f4f8);
      border: 1px solid var(--border, #e5e5ec);
      border-radius: var(--r-xs, 4px);
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      color: var(--text-muted, #797d90);
      transition: all 0.1s ease;
    }

    .agent-input-quick-action:hover {
      background: var(--surface-3, #ececf2);
      color: var(--text, #191a23);
    }

    .agent-input-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .agent-input-dialog-cancel,
    .agent-input-dialog-submit {
      padding: 8px 16px;
      border-radius: var(--r-sm, 6px);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.1s ease;
    }

    .agent-input-dialog-cancel {
      background: none;
      border: 1px solid var(--border, #e5e5ec);
      color: var(--text-muted, #797d90);
    }

    .agent-input-dialog-cancel:hover {
      background: var(--surface-2, #f4f4f8);
    }

    .agent-input-dialog-submit {
      background: var(--btn-bg, #191a23);
      border: none;
      color: var(--btn-fg, #ffffff);
    }

    .agent-input-dialog-submit:hover {
      background: var(--btn-bg-hover, #2e303e);
    }

    .agent-input-dialog-submit:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  document.head.appendChild(style);
  return dialog;
}

// ============================================================================
// Dialog Positioning
// ============================================================================

function positionDialog(dialog: HTMLElement, position: { top: number; left: number }): void {
  const margin = 16;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Start by positioning below the selection
  let top = position.top + 24;
  let left = position.left;

  // Get dialog dimensions after a brief render
  dialog.style.visibility = 'hidden';
  dialog.style.left = '0px';
  dialog.style.top = '0px';
  document.body.appendChild(dialog);

  const rect = dialog.getBoundingClientRect();

  // Adjust horizontal position
  if (left + rect.width > viewportW - margin) {
    left = viewportW - rect.width - margin;
  }
  if (left < margin) {
    left = margin;
  }

  // Adjust vertical position - prefer below, but go above if not enough space
  if (top + rect.height > viewportH - margin) {
    // Try above
    const aboveTop = position.top - rect.height - 8;
    if (aboveTop >= margin) {
      top = aboveTop;
    } else {
      // Constrain to viewport
      top = Math.max(margin, viewportH - rect.height - margin);
    }
  }

  dialog.style.visibility = '';
  dialog.style.left = `${left}px`;
  dialog.style.top = `${top}px`;
}

// ============================================================================
// Event Handlers
// ============================================================================

function handleKeyDown(e: KeyboardEvent): void {
  if (!state.isOpen) return;

  if (e.key === 'Escape') {
    closeDialog();
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    submitDialog();
    e.preventDefault();
    e.stopPropagation();
  }
}

function handleClickOutside(e: MouseEvent): void {
  if (!state.isOpen || !state.element) return;

  if (!state.element.contains(e.target as Node)) {
    closeDialog();
  }
}

function submitDialog(): void {
  if (!state.element || !state.callbacks) return;

  const textarea = state.element.querySelector('.agent-input-dialog-textarea') as HTMLTextAreaElement;
  const prompt = textarea?.value.trim();

  if (prompt) {
    state.callbacks.onSubmit(prompt);
  }

  closeDialog();
}

function closeDialog(): void {
  if (!state.element) return;

  state.element.classList.remove('visible');

  setTimeout(() => {
    if (state.element && state.element.parentNode) {
      state.element.parentNode.removeChild(state.element);
    }
    state.element = null;
    state.isOpen = false;
    state.context = null;
    state.callbacks?.onCancel();
    state.callbacks = null;
  }, 150);

  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('mousedown', handleClickOutside, true);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Show the agent input dialog
 */
export function showAgentInputDialog(
  context: AgentInputContext,
  callbacks: AgentInputCallbacks
): void {
  // Close any existing dialog
  if (state.isOpen) {
    closeDialog();
  }

  // Create new dialog
  const dialog = createDialogElement();
  state.element = dialog;
  state.isOpen = true;
  state.context = context;
  state.callbacks = callbacks;

  // Show selection if there is one
  const selectionEl = dialog.querySelector('.agent-input-dialog-selection') as HTMLElement;
  if (context.selection.trim()) {
    selectionEl.textContent = context.selection.length > 200
      ? context.selection.slice(0, 200) + '...'
      : context.selection;
    selectionEl.classList.add('has-selection');
  }

  // Position and show
  positionDialog(dialog, context.position);

  // Animate in
  requestAnimationFrame(() => {
    dialog.classList.add('visible');
  });

  // Focus textarea
  const textarea = dialog.querySelector('.agent-input-dialog-textarea') as HTMLTextAreaElement;
  setTimeout(() => {
    textarea?.focus();
  }, 50);

  // Wire up event handlers
  const closeBtn = dialog.querySelector('.agent-input-dialog-close') as HTMLButtonElement;
  const cancelBtn = dialog.querySelector('.agent-input-dialog-cancel') as HTMLButtonElement;
  const submitBtn = dialog.querySelector('.agent-input-dialog-submit') as HTMLButtonElement;
  const quickActions = dialog.querySelectorAll('.agent-input-quick-action');

  closeBtn?.addEventListener('click', closeDialog);
  cancelBtn?.addEventListener('click', closeDialog);
  submitBtn?.addEventListener('click', submitDialog);

  // Quick actions
  quickActions.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      if (action && state.callbacks) {
        // Use quick action prompt
        const prompts: Record<string, string> = {
          'fix-grammar': 'Fix any grammar issues in this text',
          'improve-clarity': 'Improve the clarity of this text while keeping the meaning',
          'make-shorter': 'Make this text more concise without losing important information',
        };
        state.callbacks.onSubmit(prompts[action] || action);
        closeDialog();
      }
    });
  });

  // Global event listeners
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('mousedown', handleClickOutside, true);
}

/**
 * Hide the agent input dialog
 */
export function hideAgentInputDialog(): void {
  closeDialog();
}

/**
 * Check if dialog is currently open
 */
export function isAgentInputDialogOpen(): boolean {
  return state.isOpen;
}
