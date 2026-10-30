/* Which view the dashboard shows (moved out of utils.js, #5065; no behaviour change). */
import { checkAgentView } from './agent_view.js';
import { setDockPage } from './dock_page.js';
import { state } from './state.js';
import { isCloud, normServer, LOCAL_SERVER } from './server_base.js';

const VIEW_IDS = [
    "mobile-agent-list",
    "welcome-screen",
    "chats-empty-view",
    "live-session-view",
    "history-session-view",
    "scheduler-view",
    "group-table-view",
    "messageboard-view",
    "team-page-view",
    "workflows-view",
    "cost-dashboard-view",
    "timeline-view",
    "kanban-view",
    "docs-view",
    "servers-view",
    "inbox-view",
    "artifacts-view",
];

const VIEW_DISPLAY = {
    "mobile-agent-list": "flex",
    "welcome-screen": "flex",
    "chats-empty-view": "flex",
    "live-session-view": "flex",
    "history-session-view": "flex",
    "scheduler-view": "block",
    "group-table-view": "block",
    "messageboard-view": "flex",
    "team-page-view": "flex",
    "workflows-view": "block",
    "cost-dashboard-view": "flex",
    "timeline-view": "flex",
    "kanban-view": "flex",
    "docs-view": "block",
    "servers-view": "block",
    "inbox-view": "flex",
    "artifacts-view": "flex",
};

const FULL_WIDTH_VIEWS = new Set([
    "timeline-view",
    "kanban-view",
    "servers-view",
    "inbox-view",
    "artifacts-view",
]);

let _viewChanges = 0;
const shownHooks = [];

/** fn(viewId) runs after every showView. */
export function onViewShown(fn) { shownHooks.push(fn); }

/** How many times showView has run: a view that loads asynchronously compares it to tell whether another view was shown meanwhile. */
export function viewChanges() { return _viewChanges; }

/** Build the welcome screen from its template (once). A phone shows the agent list as its home and never builds it (#4497); a wide window builds it at start. */
export function buildWelcome() {
    const host = document.getElementById('welcome-screen');
    const tpl = document.getElementById('welcome-template');
    if (!host || !tpl) return false;
    host.appendChild(tpl.content.cloneNode(true));
    tpl.remove();
    document.dispatchEvent(new CustomEvent('coral:welcome-built'));
    return true;
}

export function showView(activeId) {
    _viewChanges++;
    state.atWelcome = activeId === 'welcome-screen'; // the welcome page is on screen: no agent row is the selected one (session_rows.js, #10035)
    if (activeId === 'welcome-screen') buildWelcome();
    for (const id of VIEW_IDS) {
        const el = document.getElementById(id);
        if (el) el.style.display = id === activeId ? VIEW_DISPLAY[id] : "none";
    }
    const layout = document.querySelector('.layout');
    if (layout) layout.classList.toggle('sidebar-hidden', FULL_WIDTH_VIEWS.has(activeId) && !(activeId === 'inbox-view' && !isCloud())); // the Inbox has its pane except as the hub's frame (#7472)
    document.body.classList.toggle('live-session-active', activeId === 'live-session-view');
    document.body.classList.toggle('agent-home-active', activeId === 'mobile-agent-list');
    document.body.classList.toggle('phone-nav-on', activeId === 'mobile-agent-list' || activeId === 'inbox-view' || activeId === 'group-table-view'); // the phone's floating nav is on the Agents page and the Inbox's pages: the Inbox itself and its Board history (#11116)
    for (const it of document.querySelectorAll('.phone-nav-slot[data-phone-nav]')) { const on = (it.dataset.phoneNav === 'nav-agents' && activeId === 'mobile-agent-list') || (it.dataset.phoneNav === 'nav-inbox' && (activeId === 'inbox-view' || activeId === 'group-table-view')); it.classList.toggle('active', on); if (on) it.setAttribute('aria-current', 'page'); else it.removeAttribute('aria-current'); } // the phone's Agents page has its own top bar in its header (#11096)
    // Which CLI the agent page on screen is, for the lines that are about one CLI only (the "Claude is not signed in" line, #6070): its type, or "remote" for an agent on another computer or seen through
    // Coral Hub (this computer's CLI says nothing about it); empty off an agent's page. Plain CSS reads it, so no listener is needed at startup.
    const open = activeId === 'live-session-view' ? state.currentSession : null;
    const cli = !open || open.type !== 'live' || !open.agent_type ? '' : (isCloud() || normServer(open.server) !== LOCAL_SERVER) ? 'remote' : open.agent_type;
    if ((document.body.getAttribute('data-agent-cli') || '') !== cli) document.body.setAttribute('data-agent-cli', cli); // (written only when it changes: the startup sequence does not gain a write)
    setDockPage(activeId); // the right sidebar follows the kind of page: its tabs and its own open state (#4539)
    for (const fn of shownHooks) fn(activeId); // the way back from an item to its group's table follows the view (sidebar_groups.js, #7443)
    checkAgentView(); // the agent's pollers and terminal socket follow whether its page is on screen (#3719)
}
