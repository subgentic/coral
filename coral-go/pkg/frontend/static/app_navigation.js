/* Dashboard tab navigation and the home view. */

import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { urlSearchFor } from './search_filters.js';
import { showSidebarPane } from './sidebar.js';
import { note, currentRoute } from './nav.js';
import { liveRoute, keyRoute } from './routes.js';
import { showView, viewChanges } from './utils.js';
import { showMessageBoardProjects } from './message_board.js';
import { syncMobileAgentList } from './mobile.js';
import { sessionServer } from './server_base.js';
import { refreshGroupTable } from './sidebar_groups.js';
import { loadWorkflows, loadCostDashboard, loadDocs } from './lazy_panels.js';
import { isCloud } from './server_base.js';
import { getHistoryPage } from './history_state.js';
import { loadHistoryFiltered } from './history_filters.js';
import { historyRoute } from './history_source.js';
import { stopCostDashboard } from './app_panels.js';

let _navGeneration = 0;

export function switchNavTab(tab, opts = {}) {
    // The Chats tab is the Inbox's chat folders (#7776) on a local Coral: an old link, a shortcut or a Back to the chats opens the Inbox on the folder (All chats unless one is named), and an open chat shows under the Inbox. The hub keeps its Chats tab.
    const routeTab = tab, chatsInInbox = tab === 'history' && !isCloud();
    if (chatsInInbox) tab = 'hub-inbox';
    // A panel that loads on first use (lazy_panels.js) shows its view only if
    // nothing else was selected or shown while it loaded. Once loaded it shows at once.
    const generation = ++_navGeneration;
    const showWhenLoaded = (load, fn) => {
        if (load.module) { load.module[fn](); return; }
        const views = viewChanges();
        load().then(m => { if (generation === _navGeneration && views === viewChanges()) m[fn](); }, () => {});
    };
    // Clean up any active cost dashboard timer when leaving tokens tab
    stopCostDashboard();
    if (tab !== 'servers') importOnce('./servers_tab.js').then(m => m.leaveServersTab());
    // The URL follows the tab (#3532): a tab the user chose is a history entry. Servers writes its
    // own (it can carry a server); the board tab names no board, so it keeps the URL.
    const TAB_ROUTE = { agents: 'agents', history: 'chats', workflows: 'workflows', jobs: 'jobs', tokens: 'analytics', docs: 'docs' };
    if (!opts.fromHistory && TAB_ROUTE[routeTab]) {
        const cur = currentRoute();
        const route = tabRoute(routeTab, TAB_ROUTE[routeTab]);
        if (!cur || cur.view !== route.view || cur.id !== route.id || cur.server !== route.server || cur.sub !== route.sub && route.view === 'analytics') note(route);
    }

    // Toggle sidebar visibility — full-width views hide the sidebar
    const fullWidthTabs = new Set(['servers', 'artifacts', ...(isCloud() ? ['hub-inbox'] : [])]); // Workflows, Analytics and the Inbox have their sidebars (#7471, #7473, #7472), except where the hub serves the Inbox as a frame
    const layout = document.querySelector('.layout');
    if (layout) layout.classList.toggle('sidebar-hidden', fullWidthTabs.has(tab));

    // Update the nav buttons: page navigation, so the current one is aria-current="page".
    document.querySelectorAll('.top-nav-tab').forEach(btn => { btn.classList.remove('active'); btn.removeAttribute('aria-current'); });
    if (document.body.getAttribute('data-nav-tab') !== tab) document.body.setAttribute('data-nav-tab', tab); // what a page-scoped note (the Claude sign-in line) follows
    const activeTab = document.getElementById(`nav-tab-${tab}`);
    if (activeTab) { activeTab.classList.add('active'); activeTab.setAttribute('aria-current', 'page'); }

    // The sidebar shows the pane of the tab (its header, list and pinned action: sidebar.js)
    showSidebarPane(tab);

    // Switch main view based on tab
    if (tab === 'board') {
        showMessageBoardProjects();
    } else if (tab === 'jobs') {
        document.getElementById('scheduler-view')?.removeAttribute('data-phone-item'); // a phone opens Jobs on its list
        showView('scheduler-view');
    } else if (tab === 'workflows') {
        showWhenLoaded(loadWorkflows, 'showWorkflowsTab');
    } else if (tab === 'docs') {
        showWhenLoaded(loadDocs, 'showDocsTab');
    } else if (tab === 'servers') {
        showView('servers-view');
        if (!opts.fromHistory) note(opts.focusId ? { view: 'servers', id: opts.focusId } : { view: 'servers' });
        importOnce('./servers_tab.js').then(m => m.showServersTabContent(opts.focusId));
    } else if (tab === 'hub-inbox') {
        // The hub's /inbox page in a frame where the hub serves the dashboard, the dashboard's own Inbox (Needs you, Saved for later) on every other Coral (#4811); the tab writes no address of its own.
        const chatOpen = chatsInInbox && state.currentSession && state.currentSession.type === 'history';
        showView(chatOpen ? 'history-session-view' : 'inbox-view');
        importOnce('./inbox_tab.js').then(m => m.showInboxTabContent(chatsInInbox ? { folder: opts.folder || (state.inboxFolder && state.inboxFolder.key) || 'chats', quiet: chatOpen } : { folder: opts.folder || '' }));
    } else if (tab === 'artifacts') {
        // The hub's /artifacts page in a frame (artifacts_tab.js), the Inbox's way; the tab writes no address of its own.
        showView('artifacts-view');
        importOnce('./artifacts_tab.js').then(m => m.showArtifactsTabContent());
    } else if (tab === 'tokens') {
        showWhenLoaded(loadCostDashboard, 'showCostDashboard');
    } else if (tab === 'history') {
        // History is populated by the background indexer, so the cached list may
        // have changed while another tab was active. Refresh it whenever the
        // user returns while preserving the current page and filters.
        loadHistoryFiltered();
        if (state.currentSession && state.currentSession.type === 'history') {
            showView('history-session-view');
        } else {
            showView('chats-empty-view');
        }
    } else if (tab === 'agents' && isPhoneLayout()) {
        syncMobileAgentList();
        showView('mobile-agent-list');
    } else if (tab === 'agents') {
        // Restore previously selected session or show welcome
        if (state.currentSession && state.currentSession.type === 'live') {
            showView('live-session-view');
        } else {
            showView('welcome-screen');
        }
    }
    // A tab with groups that shows its empty page opens on its first group's table (sidebar_groups.js)
    if (tab === 'jobs' || tab === 'history') refreshGroupTable(tab);
}

function tabRoute(tab, view) {
    const cur = state.currentSession;
    if (tab === 'agents' && state.selectedTeam) return keyRoute('team', state.selectedTeam);
    if (tab === 'agents' && cur && cur.type === 'live' && !isPhoneLayout()) return liveRoute(sessionServer(cur), cur.session_id);
    if (tab === 'tokens' && !isPhoneLayout() && state.analyticsView !== 'overview') return { view, sub: state.analyticsView }; // the page that was open (a phone starts at the list)
    if (tab === 'history') return historyRoute(cur?.type === 'history' ? cur.name : null, currentChatsQuery());
    return { view };
}

export function currentChatsQuery() {
    return urlSearchFor(getHistoryPage(), '').replace(/^\?/, '');
}

export function showHome() {
    showView(isPhoneLayout() ? "mobile-agent-list" : "welcome-screen");
    // Deselect sidebar items
    document.querySelectorAll('.sidebar .session-item.active, .sidebar .session-item.selected').forEach(el => {
        el.classList.remove('active', 'selected');
    });
}
