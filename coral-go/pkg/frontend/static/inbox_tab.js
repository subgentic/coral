import './inbox_servers.js'; // source helpers shared by lazy Inbox filters and lists
import { needsInputAttention } from './display_activity_hint.js';
/* Inbox tab (#4718, #4811, #7472): on every Coral. Where the hub serves the dashboard it is the Coral Hub's /inbox page (what needs the Operator, what was saved) inside the dashboard, in a
 * frame whose address is the constant below: never built from a URL, a hash or a message, and nothing is posted to or read from the frame. On every other Coral the dashboard builds its own
 * Inbox on the shared sidebar: three groups, Needs you (the agents waiting for input, from the live list the dashboard already holds, each opening that agent), Tasks and Saved for later, whose names
 * open a table in the centre (inbox_sidebar.js, loaded the first time the tab is shown). This file is the part that is always loaded: the tab's badge with the number of agents waiting for input,
 * the three counts, and the announcement of an agent that has just started waiting. */

import { state } from './state.js';
import { unreadReviewItems, refreshReviews, onReviewsChanged } from './inbox_reviews.js';
import { isCloud, sessionServer } from './server_base.js';
import { importOnce } from './import_once.js';
import { resolveSessionIdentity, sessionStateInfo } from './session_state.js';
import './safe_markdown.js'; // the shared Inbox renderer's wrapper: the lazy Inbox modules import it, and a lazy module imports only what loads at startup (import_hygiene)

const INBOX_URL = '/inbox';
onReviewsChanged(() => updateInboxTab());

/** How many agents are waiting for input right now, from the feed's list. */
export function waitingCount() {
    return (state.liveSessions || []).filter(needsInputAttention).length;
}

/** Keep the tab's badge (and, where the dashboard builds its own Inbox, the Needs you list) in step with the live list. Safe to call often (after each list update). */
export function updateInboxTab() {
    const tab = document.getElementById('nav-tab-hub-inbox');
    if (!tab) return;
    if (tab.hidden) tab.hidden = false; // the Inbox is on every Coral
    const badge = document.getElementById('nav-tab-hub-inbox-badge');
    if (!badge) return;
    refreshReviews();
    const n = waitingCount() + unreadReviewItems().length; // a review artifact the operator has read stays listed but is not counted (#9277)
    const text = n > 99 ? '99+' : n > 0 ? String(n) : '';
    // Only what changed is written: nav_tabs.js redraws the row on any change to it, and this runs for every message of the feed (setting hidden to
    // the value it has is still a change to a MutationObserver).
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.hidden !== (n === 0)) badge.hidden = n === 0;
    const label = n > 0 ? unreadReviewItems().length ? `Inbox, ${n} need your attention` : `Inbox, ${n} waiting for input` : null;
    if (tab.getAttribute('aria-label') !== label) { if (label) tab.setAttribute('aria-label', label); else tab.removeAttribute('aria-label'); }
    setInboxCount('needs', n);
    _hooks.needs?.(); // the Needs you rows, once the sidebar is loaded and while the Inbox is on screen
    announceNewlyWaiting(tab);
}

// The count of each of the Inbox's three groups (Needs you, Tasks, Saved) and how many tasks are high priority. A count that is not known yet (the tasks before the first read) is 0. The sidebar (once
// it is loaded) draws them in its group headers and tables: it is told through the hooks below.
const _counts = { needs: 0, tasks: 0, saved: 0 }, _high = { tasks: 0 };
const _hooks = {};
/** The Inbox's sidebar (inbox_sidebar.js) tells this file what to call when the list of agents waiting changes (needs) and when a count does (counts). */
export function onInboxHooks(h) { Object.assign(_hooks, h); }
export function setInboxCount(kind, n, high = 0) {
    if (!(kind in _counts)) return;
    n = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    high = Number.isFinite(high) && high > 0 ? Math.min(Math.floor(high), n) : 0;
    if (_counts[kind] === n && (kind !== 'tasks' || _high.tasks === high)) return;
    _counts[kind] = n;
    if (kind === 'tasks') _high.tasks = high;
    _hooks.counts?.();
}

let _announced = null; // the agents that were waiting at the last look (null before the first)
const waitingKey = s => `${sessionServer(s)}|${s.session_id}`;
/** A screen reader hears who has just started waiting, once each (#4926): "<agent> needs you: <why>" in a polite live region of the Inbox. Only an agent that was not waiting at the last look is new, so a redraw of
 *  the list, a refresh of the same agents, or the page loading with agents already waiting says nothing. It speaks only while the Inbox is on screen: elsewhere the toast ("needs input") and the tab's badge
 *  carry it, and a second voice for the same agent would only repeat it. The look is kept up while the Inbox is not shown, so what waited meanwhile is in the list but not announced when it is opened. */
function announceNewlyWaiting(tab) {
    const rows = (state.liveSessions || []).filter(needsInputAttention);
    const now = new Set(rows.map(waitingKey));
    const before = _announced;
    _announced = now;
    if (!before) return;
    const live = document.getElementById('inbox-live');
    const shown = !!live && tab.classList.contains('active') && !document.getElementById('inbox-local')?.hidden;
    const fresh = rows.filter(s => !before.has(waitingKey(s)));
    if (!shown || !fresh.length) return;
    const span = document.createElement('span'); // a new node each time: the same words for the same agent waiting again are said again
    span.textContent = fresh.map(s => `${resolveSessionIdentity(s)} needs you: ${needsWords(s)}`).join('. ');
    live.replaceChildren(span);
}

/** What a Needs you row says an agent waits for, in one string: the state's words, then the agent's own ask when it has one (the same words as the row's two lines, so the announcement never differs from the row). */
const askOf = s => String(s.waiting_summary || '').replace(/\s+/g, ' ').trim();
const needsWords = s => { const why = sessionStateInfo(s).label, ask = askOf(s); return ask && ask !== why ? `${why}. ${ask}` : why; };

export { askOf };

/** Which group of the dashboard's own Inbox a caller wants on screen (the Saved button of the top bar brings the Saved group's table up): the Inbox's sidebar opens it. */
/** The group the Inbox opens on, named before the tab is switched to, so no frame shows the last group first (the bookmark opens the Inbox on Saved, #7431). */
export function rememberInboxGroup(name) { return importOnce('./inbox_sidebar.js').then(m => m.rememberGroup(name)); }
export function selectInboxTab(name) { return importOnce('./inbox_sidebar.js').then(m => m.openInboxGroup(name)); }

/** Called by switchNavTab('hub-inbox'): where the hub serves the dashboard the page is loaded the first time the tab is shown, and kept after; elsewhere the dashboard's own Inbox is drawn. */
/** `folder` names the folder to open on (a chat folder from an old Chats link); `quiet` draws the Inbox without opening a table (a chat is on screen over it). */
export function showInboxTabContent({ folder = '', quiet = false } = {}) {
    const view = document.getElementById('inbox-view');
    if (!view) return;
    if (!isCloud()) {
        const local = document.getElementById('inbox-local');
        if (local) local.hidden = false;
        importOnce('./inbox_sidebar.js').then(m => m.showInbox({ folder, quiet })).catch(() => {}); // the groups, their tables and a task's or a message's page
        return;
    }
    if (document.getElementById('inbox-frame')) return;
    // Made here, not in the page: a page that never shows the tab (a hub visit that stays on Agents) carries no empty frame.
    const frame = document.createElement('iframe');
    frame.id = 'inbox-frame';
    frame.className = 'inbox-frame';
    frame.title = 'Inbox';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', ''); // no camera, microphone, geolocation or other powerful features
    frame.setAttribute('src', INBOX_URL);
    view.append(frame);
}

updateInboxTab();
