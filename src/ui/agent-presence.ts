/**
 * Agent Presence UI
 *
 * A section in the left sidebar showing active agents with:
 * - Status indicator (thinking/acting/completed/cancelled/error/interrupted)
 * - Thinking summary (updated via Haiku)
 * - Token count and estimated cost
 * - Cancel button
 * - Resume/Discard for interrupted sessions
 * - Click to toggle follow
 */

import type { AgentSession, AgentSessionStatus } from '../agent/session-manager';
import { getSessionManager } from '../agent/session-manager';
import {
  createAgentFaceElement,
  getAgentFacePalette,
  resolveAgentFamily,
} from './agent-identity-icon';

// ============================================================================
// Types
// ============================================================================

interface AgentPresenceState {
  element: HTMLElement | null;
  sessions: AgentSession[];
  followingAgent: string | null;
  unsubscribe: (() => void) | null;
}

interface AgentPresenceCallbacks {
  onAgentClick: (sessionId: string) => void;
  onAgentDoubleClick: (sessionId: string) => void;
  onAgentCancel: (sessionId: string) => void;
  onAgentResume: (sessionId: string) => void;
  onAgentDiscard: (sessionId: string) => void;
}

// ============================================================================
// State
// ============================================================================

const state: AgentPresenceState = {
  element: null,
  sessions: [],
  followingAgent: null,
  unsubscribe: null,
};

let callbacks: AgentPresenceCallbacks = {
  onAgentClick: () => {},
  onAgentDoubleClick: () => {},
  onAgentCancel: () => {},
  onAgentResume: () => {},
  onAgentDiscard: () => {},
};

// ============================================================================
// Status Display
// ============================================================================

const STATUS_CONFIG: Record<AgentSessionStatus, {
  icon: string;
  label: string;
  className: string;
}> = {
  idle: { icon: '○', label: 'Ready', className: 'idle' },
  reading: { icon: '◐', label: 'Reading...', className: 'reading' },
  thinking: { icon: '●', label: 'Thinking...', className: 'thinking' },
  acting: { icon: '●', label: 'Working...', className: 'acting' },
  waiting: { icon: '○', label: 'Waiting', className: 'waiting' },
  completed: { icon: '✓', label: 'Done', className: 'completed' },
  cancelled: { icon: '✗', label: 'Cancelled', className: 'cancelled' },
  error: { icon: '!', label: 'Error', className: 'error' },
  interrupted: { icon: '⚠', label: 'Interrupted', className: 'interrupted' },
};

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    return '<$0.01';
  }
  return `$${cost.toFixed(2)}`;
}

// ============================================================================
// Rendering
// ============================================================================

function formatExternalAgentName(agentId: string): string {
  const known: Record<string, string> = {
    'claude-code': 'Claude Code',
    'claude': 'Claude',
    'proof-agent': 'Proof Agent',
  };
  if (known[agentId]) return known[agentId];
  // Convert kebab-case/snake_case to Title Case
  return agentId
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function createAgentCard(session: AgentSession, isFollowing: boolean): HTMLElement {
  const config = STATUS_CONFIG[session.status];
  const isExternal = session.id.startsWith('external-');
  const skillName = session.skill || 'Agent';
  const family = resolveAgentFamily({ id: session.id, skill: skillName, name: skillName });
  const familyPalette = getAgentFacePalette(family);

  const card = document.createElement('div');
  const typeClass = isExternal ? 'external' : 'embedded';
  card.className = `agent-card ${config.className} ${typeClass} agent-card--${family}${isFollowing ? ' following' : ''}`;
  card.dataset.sessionId = session.id;
  card.dataset.agentFamily = family;
  card.style.setProperty('--agent-family-accent', familyPalette.accent);

  const displayName = isExternal ? formatExternalAgentName(skillName) : skillName;
  const thinking = session.currentThinking || config.label;

  card.innerHTML = `
    <div class="agent-card-header">
      <span class="agent-identity-slot"></span>
      <span class="agent-status-icon">${config.icon}</span>
      <span class="agent-skill-name">${displayName}</span>
      ${isFollowing ? '<span class="agent-following-badge">Following</span>' : ''}
    </div>
    <div class="agent-card-thinking">${thinking}</div>
    <div class="agent-card-footer">
      ${session.documentPosition !== null ? `<span class="agent-position">Pg ${Math.ceil(session.documentPosition / 2000)}</span>` : ''}
      ${!isExternal ? `<span class="agent-tokens">${formatTokens(session.tokensUsed)} tok</span>
      <span class="agent-cost">${formatCost(session.estimatedCost)}</span>` : ''}
    </div>
    <div class="agent-card-actions">
      ${!isExternal && session.status === 'interrupted'
        ? `<button class="agent-action-btn resume-btn">Resume</button>
           <button class="agent-action-btn discard-btn">Discard</button>`
        : (!isExternal && (session.status === 'reading' || session.status === 'thinking' || session.status === 'acting' || session.status === 'waiting'))
          ? `<button class="agent-action-btn cancel-btn">Cancel</button>`
          : ''
      }
    </div>
  `;

  const identitySlot = card.querySelector('.agent-identity-slot');
  if (identitySlot) {
    identitySlot.appendChild(createAgentFaceElement({
      family,
      size: 18,
      title: `${displayName} icon`,
      wrapperClassName: 'agent-identity-icon',
      className: 'agent-identity-icon__svg',
    }));
  }

  // Event handlers
  card.addEventListener('click', (e) => {
    // Ignore clicks on buttons
    if ((e.target as HTMLElement).closest('.agent-action-btn')) return;
    callbacks.onAgentClick(session.id);
  });

  // Action buttons
  const cancelBtn = card.querySelector('.cancel-btn');
  const resumeBtn = card.querySelector('.resume-btn');
  const discardBtn = card.querySelector('.discard-btn');

  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onAgentCancel(session.id);
  });

  resumeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onAgentResume(session.id);
  });

  discardBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onAgentDiscard(session.id);
  });

  return card;
}

function renderAgentList(): void {
  if (!state.element) return;

  const container = state.element.querySelector('.agent-presence-list');
  if (!container) return;

  container.innerHTML = '';

  // Filter to show relevant sessions (active + interrupted + recent completed)
  const relevantSessions = state.sessions.filter((s) => {
    if (s.status === 'interrupted') return true;
    if (s.status === 'reading' || s.status === 'thinking' || s.status === 'acting' || s.status === 'waiting') return true;
    // Show completed/cancelled/error for 2 minutes
    const age = Date.now() - s.lastActivity.getTime();
    if (age < 120000) return true;
    return false;
  });

  if (relevantSessions.length === 0) {
    state.element.style.display = 'none';
    return;
  }

  state.element.style.display = '';

  for (const session of relevantSessions) {
    const card = createAgentCard(session, state.followingAgent === session.id);
    container.appendChild(card);
  }
}

function updateHeader(): void {
  if (!state.element) return;

  const header = state.element.querySelector('.agent-presence-header');
  if (!header) return;

  const activeCount = state.sessions.filter(
    (s) => s.status === 'reading' || s.status === 'thinking' || s.status === 'acting' || s.status === 'waiting'
  ).length;

  header.textContent = `Active Agents${activeCount > 0 ? ` (${activeCount})` : ''}`;
}

// ============================================================================
// Element Creation
// ============================================================================

function createPresenceElement(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'agent-presence';
  element.innerHTML = `
    <div class="agent-presence-header">Active Agents</div>
    <div class="agent-presence-list"></div>
  `;

  // Add styles if not already added
  if (!document.getElementById('agent-presence-styles')) {
    const style = document.createElement('style');
    style.id = 'agent-presence-styles';
    style.textContent = `
      .agent-presence {
        padding: 12px 0;
        border-top: 1px solid var(--border, #e5e5ec);
      }

      .agent-presence-header {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-muted, #797d90);
        padding: 0 16px 8px;
      }

      .agent-presence-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 0 8px;
      }

      .agent-presence-empty {
        font-size: 13px;
        color: var(--text-faint, #a6a9b8);
        padding: 8px 8px;
        text-align: center;
        font-style: italic;
      }

      .agent-card {
        background: var(--surface-2, #f4f4f8);
        border: 1px solid var(--border, #e5e5ec);
        border-left: 3px solid var(--agent-family-accent, var(--ai, #7c3aed));
        border-radius: var(--r-md, 8px);
        padding: 10px 12px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .agent-card:hover {
        background: var(--surface-3, #ececf2);
        border-color: var(--border-strong, #d4d5df);
      }

      .agent-card.following {
        border-color: var(--link, #2563eb);
        box-shadow: 0 0 0 3px var(--focus, rgba(37, 99, 235, 0.32));
      }

      .agent-card-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
      }

      .agent-identity-slot {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .agent-identity-icon {
        filter: drop-shadow(0 1px 1px rgba(15, 23, 42, 0.08));
      }

      .agent-status-icon {
        font-size: 10px;
        line-height: 1;
        width: 10px;
        text-align: center;
      }

      .agent-card.reading .agent-status-icon,
      .agent-card.thinking .agent-status-icon,
      .agent-card.acting .agent-status-icon {
        color: var(--link, #2563eb);
        animation: pulse 1.5s ease-in-out infinite;
      }

      .agent-card.completed .agent-status-icon {
        color: var(--ok, #16a34a);
      }

      .agent-card.error .agent-status-icon,
      .agent-card.interrupted .agent-status-icon {
        color: var(--warn, #d97706);
      }

      .agent-card.cancelled .agent-status-icon {
        color: var(--text-faint, #a6a9b8);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .agent-skill-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text, #191a23);
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .agent-following-badge {
        font-size: 10px;
        background: var(--btn-bg, #191a23);
        color: var(--btn-fg, #ffffff);
        padding: 2px 6px;
        border-radius: var(--r-xs, 4px);
      }

      .agent-card-thinking {
        font-size: 12px;
        color: var(--text-muted, #797d90);
        margin-bottom: 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .agent-card-footer {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: var(--text-faint, #a6a9b8);
      }

      .agent-position {
        background: var(--surface-3, #ececf2);
        padding: 2px 6px;
        border-radius: var(--r-xs, 4px);
        cursor: pointer;
      }

      .agent-position:hover {
        background: var(--border-strong, #d4d5df);
      }

      .agent-card-actions {
        margin-top: 8px;
        display: flex;
        gap: 8px;
      }

      .agent-action-btn {
        flex: 1;
        padding: 4px 8px;
        font-size: 11px;
        border: 1px solid var(--border, #e5e5ec);
        border-radius: var(--r-sm, 6px);
        background: var(--surface, #ffffff);
        color: var(--text-muted, #797d90);
        cursor: pointer;
        transition: all 0.1s ease;
      }

      .agent-action-btn:hover {
        background: var(--surface-3, #ececf2);
        color: var(--text, #191a23);
      }

      .agent-action-btn.cancel-btn:hover {
        background: color-mix(in srgb, var(--err, #dc2626) 10%, transparent);
        border-color: var(--err, #dc2626);
        color: var(--err, #dc2626);
      }

      .agent-action-btn.resume-btn:hover {
        background: color-mix(in srgb, var(--ok, #16a34a) 12%, transparent);
        border-color: var(--ok, #16a34a);
        color: var(--ok, #16a34a);
      }
    `;
    document.head.appendChild(style);
  }

  return element;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the agent presence UI
 */
export function initAgentPresence(
  container: HTMLElement,
  options: Partial<AgentPresenceCallbacks> = {}
): HTMLElement {
  // Set callbacks
  callbacks = {
    onAgentClick: options.onAgentClick || (() => {}),
    onAgentDoubleClick: options.onAgentDoubleClick || (() => {}),
    onAgentCancel: options.onAgentCancel || (() => {}),
    onAgentResume: options.onAgentResume || (() => {}),
    onAgentDiscard: options.onAgentDiscard || (() => {}),
  };

  // Create element
  const element = createPresenceElement();
  state.element = element;
  container.appendChild(element);

  // Subscribe to session manager updates
  const sessionManager = getSessionManager();
  state.sessions = sessionManager.getAllSessions();
  state.unsubscribe = sessionManager.onSessionChange((sessions) => {
    state.sessions = sessions;
    renderAgentList();
    updateHeader();
  });

  // Initial render
  renderAgentList();
  updateHeader();

  return element;
}

/**
 * Update the following agent
 */
export function setFollowingAgent(sessionId: string | null): void {
  state.followingAgent = sessionId;
  renderAgentList();
}

/**
 * Get the currently following agent
 */
export function getFollowingAgent(): string | null {
  return state.followingAgent;
}

/**
 * Cleanup the agent presence UI
 */
export function cleanupAgentPresence(): void {
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }

  if (state.element && state.element.parentNode) {
    state.element.parentNode.removeChild(state.element);
  }

  state.element = null;
  state.sessions = [];
  state.followingAgent = null;
}

/**
 * Force refresh the UI
 */
export function refreshAgentPresence(): void {
  const sessionManager = getSessionManager();
  state.sessions = sessionManager.getAllSessions();
  renderAgentList();
  updateHeader();
}
