/* The right sidebar is part of the app layout (#4539), so it is on every page; each kind of page picks its tabs and keeps its own open or closed state, width and last tab.
 * The kinds: the agent's page (today's tabs), Chats (Saved), every other page (Saved), and "none": the board's page and the team's page have no right sidebar (#7457; the team page
 * has its tabs and detail pane, the board's page a link to it). The tab sets are in
 * the markup (data-pages on a tab) and the CSS (#agentic-state[data-page]); this module knows the kind of the page on screen and tells the modules that own the layout
 * and the tabs (sidebar.js, agentic_state.js) when it changes. showView (utils.js) is the one caller of setDockPage. */
import { browserLocal } from './safe_storage.js';
import { state } from './state.js';

const KIND_OF_VIEW = {
    'live-session-view': 'agent',
    'messageboard-view': 'none',
    'team-page-view': 'none',
    'history-session-view': 'chats',
    'chats-empty-view': 'chats',
};
/** Open on first use? The agent page has always shown its side column; the others start closed. */
const OPEN_BY_DEFAULT = { agent: true, none: false, chats: false, other: false };
/** The tab a kind of page opens on when it has no remembered one. */
export const DEFAULT_TAB = { agent: 'files', chats: 'saved', other: 'saved' };

let kind = 'agent';
const hooks = [];

export const dockKind = () => kind;
/** A tablet's first chat starts with the side column closed: beside it the chat would have under 400 px, and the column is an empty file list on a first visit (#10079). */
export const DOCK_OPEN_MIN_WIDTH = 1000;
export function dockOpenByDefault(k = kind) { return k === 'agent' ? OPEN_BY_DEFAULT.agent && window.innerWidth >= DOCK_OPEN_MIN_WIDTH : OPEN_BY_DEFAULT[k]; }

/** A storage key for the page on screen: the agent page keeps its original keys, the others add their kind; a popout window has its own (it must not overwrite the dashboard's sizes). */
export function dockKey(base, k = kind) {
    return `${base}${k === 'agent' ? '' : ':' + k}${document.body.classList.contains('popout-mode') ? ':popout' : ''}`;
}

/** The board the board's page or the team's page shows (an identity key), or null on any other page: an artifact opened there asks its comments of that board. */
export function boardOfPage() { return kind === 'none' ? state.boardPageProject || null : null; }

/** fn(kind, previous) runs when the kind of the page on screen changes (and once for the first page). */
export function onDockPage(fn) { hooks.push(fn); }

/** Whether a tab button is on the page on screen: asks the style sheet, so a tab a page or the user hides is not counted. */
export function tabShown(btn) { return !!btn && btn.style.display !== 'none' && getComputedStyle(btn).display !== 'none'; }

export function setDockPage(viewId) {
    // The populated Chats list uses the shared table view; it keeps the same
    // dock state as the empty list and transcripts, not other lists' state (#7953).
    const chatTable = viewId === 'group-table-view' && document.getElementById(viewId)?.dataset.group?.startsWith('history:');
    const next = chatTable ? 'chats' : KIND_OF_VIEW[viewId] || 'other';
    const dock = document.getElementById('agentic-state');
    if (dock) dock.dataset.page = next;
    document.body.setAttribute('data-dock-page', next);
    if (next === kind && dock?.dataset.pageApplied) return;
    const previous = kind;
    kind = next;
    if (dock) dock.dataset.pageApplied = '1';
    for (const fn of hooks) {
        try { fn(next, previous); } catch (e) { console.error('dock page hook failed', e); }
    }
}

/** The tab the person last used on this kind of page, if it is still there. */
export function rememberedTab(k = kind) {
    try { return browserLocal.get(dockKey('coral-agentic-tab-top', k)); } catch { return null; }
}
