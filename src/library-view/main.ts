/**
 * Proof — /library view. Vanilla TS, no framework (matches every other
 * chrome widget in src/ui/*.ts; this codebase has no React dependency).
 *
 * Real-data-only: renders exactly what GET /api/library returns (title,
 * role, owned, shareState, visitCount, lastVisitedAt, updatedAt). The
 * Claude Design mock this was ported from also shows a content snippet,
 * a human/AI/mixed provenance accent, an open-comment count, an
 * agent-drafting badge, a collaborator avatar stack, starring, and a
 * "New Document" button — none of those have backend support today; see
 * docs/adr/2026-07-library-view.md for the filed follow-up issues.
 */

type LibraryRow = {
  slug: string;
  title: string | null;
  shareState: string;
  role: string | null;
  owned: boolean;
  visitCount: number;
  lastVisitedAt: string | null;
  updatedAt: string | null;
};

type ViewId = 'recent' | 'owned' | 'shared' | 'all';
type Layout = 'grid' | 'list';
type Sort = 'recent' | 'name' | 'activity';
type Appearance = 'light' | 'dark';

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'owned', label: 'Owned by me' },
  { id: 'shared', label: 'Shared with me' },
  { id: 'all', label: 'All documents' },
];

// Reuses the same 8 accent hues src/ui/agent-identity-icon.ts already
// established as this product's visual vocabulary for identity avatars,
// rather than inventing a new palette for the "me" avatar.
const AVATAR_PALETTE = [
  '#2F80FF', '#A3C600', '#3DC79A', '#FF8A3D',
  '#F45CAB', '#8B6BFF', '#F15B5B', '#E4B90A',
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function initialsFor(email: string): string {
  const name = email.split('@')[0] || email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return Math.floor(mins) + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  if (mins < 2880) return 'yesterday';
  if (mins < 10080) return Math.floor(mins / 1440) + 'd ago';
  return Math.floor(mins / 10080) + 'w ago';
}

function inView(d: LibraryRow, view: ViewId): boolean {
  if (view === 'owned') return d.owned;
  if (view === 'shared') return !d.owned;
  return true; // recent, all
}

function icon(path: string): string {
  return `<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

const ICONS = {
  search: icon('M9 3a6 6 0 104.2 10.2A6 6 0 009 3zm4.5 10.5L17 17'),
  recent: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="6.5"/><path d="M10 6.3V10l2.6 1.6"/></svg>',
  owned: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2H15A1.5 1.5 0 0116.5 8.5v6A1.5 1.5 0 0115 16H4.5A1.5 1.5 0 013 14.5z"/></svg>',
  shared: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7.5" r="2.2"/><path d="M3.5 15c0-2 1.6-3.4 3.5-3.4S10.5 13 10.5 15"/><circle cx="13.5" cy="8" r="1.8"/><path d="M12 15c0-1.6 1.1-2.6 2.4-2.6 1 0 1.9.6 2.3 1.6"/></svg>',
  all: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="13" height="4" rx="1"/><rect x="3.5" y="12" width="13" height="4" rx="1"/></svg>',
  grid: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1"/><rect x="11" y="11" width="5.5" height="5.5" rx="1"/></svg>',
  list: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 5.5H16M6.5 10H16M6.5 14.5H16"/><path d="M3.7 5.5h.01M3.7 10h.01M3.7 14.5h.01"/></svg>',
  doc: '<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h5L15 7v9.5A1 1 0 0114 17.5H6A1 1 0 015 16.5v-12A1 1 0 016 3.5z"/><path d="M11 3.5V7h4"/></svg>',
};

const VIEW_ICON: Record<ViewId, string> = {
  recent: ICONS.recent,
  owned: ICONS.owned,
  shared: ICONS.shared,
  all: ICONS.all,
};

function loadSavedAppearance(): Appearance {
  const saved = localStorage.getItem('proof-appearance');
  return saved === 'dark' ? 'dark' : 'light';
}

function applyAppearance(appearance: Appearance): void {
  document.documentElement.setAttribute('data-appearance', appearance);
  localStorage.setItem('proof-appearance', appearance);
}

async function main() {
  const app = document.getElementById('app');
  if (!app) return;

  let documents: LibraryRow[] = [];
  let user = '';
  let view: ViewId = 'recent';
  let layout: Layout = 'grid';
  let sort: Sort = 'recent';
  let query = '';
  let appearance = loadSavedAppearance();
  applyAppearance(appearance);

  try {
    const res = await fetch('/api/library', { headers: { accept: 'application/json' } });
    if (res.ok) {
      const body = (await res.json()) as { user: string; documents: LibraryRow[] };
      documents = body.documents ?? [];
      user = body.user ?? '';
    }
  } catch {
    // Render an empty library rather than a broken page; the fetch is
    // same-origin and best-effort like the rest of this page's data.
  }

  function counts(): Record<ViewId, number> {
    const c = {} as Record<ViewId, number>;
    for (const v of VIEWS) c[v.id] = documents.filter((d) => inView(d, v.id)).length;
    return c;
  }

  function shownDocs(): LibraryRow[] {
    const q = query.trim().toLowerCase();
    let list = documents.filter((d) => inView(d, view));
    if (q) list = list.filter((d) => (d.title ?? d.slug).toLowerCase().includes(q));
    const effectiveSort: Sort = view === 'recent' ? 'recent' : sort;
    return [...list].sort((a, b) => {
      if (effectiveSort === 'name') {
        return (a.title ?? a.slug).localeCompare(b.title ?? b.slug);
      }
      if (effectiveSort === 'activity') {
        // Real proxy for the mock's comment-count-based "Activity" sort —
        // there is no open-comment count in the D1 index today (see the
        // Tier 1 issue), so this uses visit frequency instead.
        return b.visitCount - a.visitCount;
      }
      const at = (d: LibraryRow) => d.lastVisitedAt ?? d.updatedAt ?? '';
      return at(b).localeCompare(at(a));
    });
  }

  function roleLabel(d: LibraryRow): { cls: string; text: string } {
    if (d.shareState !== 'ACTIVE') return { cls: 'deleted', text: d.shareState.toLowerCase() };
    const role = d.role ?? (d.owned ? 'owner' : null);
    return role ? { cls: role, text: role } : { cls: '', text: '' };
  }

  function renderCard(d: LibraryRow): string {
    const title = escapeHtml(d.title?.trim() || d.slug);
    const gone = d.shareState !== 'ACTIVE';
    const { cls, text } = roleLabel(d);
    const roleTag = text ? `<span class="role ${cls}">${escapeHtml(text)}</span>` : '';
    const time = relTime(d.lastVisitedAt ?? d.updatedAt);
    return `
      <button class="card${gone ? ' gone' : ''}" data-slug="${escapeHtml(d.slug)}" data-gone="${gone}">
        <div class="cbody"><div class="ctitle">${title}</div></div>
        <div class="cmeta-line">${roleTag}<span class="time">${escapeHtml(time)}</span></div>
      </button>`;
  }

  function renderRow(d: LibraryRow): string {
    const title = escapeHtml(d.title?.trim() || d.slug);
    const gone = d.shareState !== 'ACTIVE';
    const { cls, text } = roleLabel(d);
    const roleTag = text ? `<span class="role ${cls}">${escapeHtml(text)}</span>` : '';
    const time = relTime(d.lastVisitedAt ?? d.updatedAt);
    return `
      <button class="row${gone ? ' gone' : ''}" data-slug="${escapeHtml(d.slug)}" data-gone="${gone}">
        <div class="rmain"><div class="rtitle">${title}</div></div>
        <div class="rmeta">${roleTag}<span class="time">${escapeHtml(time)}</span></div>
      </button>`;
  }

  function render(): void {
    const activeView = VIEWS.find((v) => v.id === view)!;
    const shown = shownDocs();
    const c = counts();
    const sortLocked = view === 'recent';

    app!.innerHTML = `
      <div class="lib">
        <header class="topbar">
          <div class="brand">
            <div class="logo">P</div>
            <span class="wm">Proof <span class="dim">Library</span></span>
          </div>
          <div class="search">
            ${ICONS.search}
            <input value="${escapeHtml(query)}" placeholder="Search documents…" />
            <span class="kbd">/</span>
          </div>
          <div class="spacer"></div>
          <div class="me" style="background:${colorFor(user)}" title="${escapeHtml(user)}">${escapeHtml(initialsFor(user))}</div>
        </header>

        <div class="body">
          <aside class="sidebar">
            <div class="side-label">Library</div>
            <nav class="nav">
              ${VIEWS.map(
                (v) => `
                <button class="navitem${view === v.id ? ' on' : ''}" data-view="${v.id}">
                  ${VIEW_ICON[v.id]}<span>${v.label}</span><span class="n">${c[v.id]}</span>
                </button>`,
              ).join('')}
            </nav>
          </aside>

          <main class="main">
            <div class="main-head">
              <h1>${activeView.label}</h1>
              <span class="sub">${shown.length} ${shown.length === 1 ? 'document' : 'documents'}</span>
              <div class="spacer"></div>
              <div class="sortrow">
                <span class="lab">Sort</span>
                <div class="seg" style="${sortLocked ? 'opacity:.45;pointer-events:none' : ''}"
                  title="${sortLocked ? 'Recent view is always sorted by last visited' : ''}">
                  <button data-sort="recent" class="${sort === 'recent' ? 'on' : ''}">Recent</button>
                  <button data-sort="name" class="${sort === 'name' ? 'on' : ''}">Name</button>
                  <button data-sort="activity" class="${sort === 'activity' ? 'on' : ''}">Activity</button>
                </div>
              </div>
            </div>

            ${
              shown.length === 0
                ? `<div class="empty">
                    <div class="eico">${query ? ICONS.search : ICONS.doc}</div>
                    <h3>${query ? 'No documents match' : 'Nothing here yet'}</h3>
                    <p>${query ? 'Try a different search term.' : 'Documents you open or create will show up here.'}</p>
                  </div>`
                : layout === 'grid'
                  ? `<div class="grid">${shown.map(renderCard).join('')}</div>`
                  : `<div class="list">${shown.map(renderRow).join('')}</div>`
            }
          </main>
        </div>

        <div class="switcher">
          <span class="lab">View</span>
          <div class="seg">
            <button data-layout="grid" class="${layout === 'grid' ? 'on' : ''}">${ICONS.grid}Grid</button>
            <button data-layout="list" class="${layout === 'list' ? 'on' : ''}">${ICONS.list}List</button>
          </div>
          <span class="lab">Theme</span>
          <div class="seg">
            <button data-appearance-btn="light" class="${appearance === 'light' ? 'on' : ''}">Light</button>
            <button data-appearance-btn="dark" class="${appearance === 'dark' ? 'on' : ''}">Dark</button>
          </div>
        </div>
      </div>`;

    wire();
  }

  function wire(): void {
    const root = app!;
    root.querySelector<HTMLInputElement>('.search input')?.addEventListener('input', (e) => {
      query = (e.target as HTMLInputElement).value;
      render();
      root.querySelector<HTMLInputElement>('.search input')?.focus();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        view = btn.dataset.view as ViewId;
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        sort = btn.dataset.sort as Sort;
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((btn) => {
      btn.addEventListener('click', () => {
        layout = btn.dataset.layout as Layout;
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-appearance-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appearance = btn.dataset.appearanceBtn as Appearance;
        applyAppearance(appearance);
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('.card[data-slug], .row[data-slug]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.gone === 'true') return;
        window.location.href = `/d/${encodeURIComponent(el.dataset.slug!)}`;
      });
    });
  }

  window.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !typing) {
      e.preventDefault();
      app!.querySelector<HTMLInputElement>('.search input')?.focus();
    }
  });

  render();
}

main();
