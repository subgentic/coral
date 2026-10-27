/* Dashboard route handlers and initial route selection. */

import { isPhoneLayout } from './phone_layout.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { deserializeFromUrl } from './search_filters.js';
import { selectHistorySession } from './sessions.js';
import { startNav, go, note, onRoute, currentRoute } from './nav.js';
import { liveRoute, keyRoute, routeKey, AGENT_SUBTABS, parse as parseRoute, cloudRedirect } from './routes.js';
import { showTerminalView } from './live_chat.js';
import { switchAgenticTab } from './agentic_state.js';
import { showView, showToast } from './utils.js';
import { sessionServer } from './server_base.js';
import { loadAutomations, loadDocs } from './lazy_panels.js';
import { isCloud } from './server_base.js';
import { setHistoryPage } from './history_state.js';
import { syncFilterDomToState } from './history_filters.js';
import { historyServer, setHistorySource } from './history_source.js';
import { switchNavTab, currentChatsQuery, showHome } from './app_navigation.js';
import { START_SEARCH, liveListReady } from './initial_load.js';
import { openTeamPage, applyTeamRoute, exitTeamPage } from './app_panels.js';

function notFound(message, listRoute) {
    showToast(message, true);
    return go(listRoute, { replace: true });
}

function registerRouteHandlers() {
    // Any view but a team leaves the team workspace (Back from a team to where the user was).
    const route = (view, fn) => onRoute(view, async (r, opts) => {
        const home = cloudRedirect({ view }, isCloud()); if (home.view !== view) return go(home, { replace: true }); // the Hub does not serve Automations (#9368); the tab and menu rows are hidden (nav_tabs.js, cloud.css)
        if (state.selectedTeam && await exitTeamPage() === false) {
            note(keyRoute('team', state.selectedTeam), { replace: true }); // kept: unsaved team settings
            return;
        }
        await fn(r, opts);
    });

    route('agents', async (r, opts) => {
        if (!r.id) {
            switchNavTab('agents', { fromHistory: true });
            if (!opts.startup) showHome();
            return;
        }
        await liveListReady;
        const s = (state.liveSessions || []).find(x => String(x.session_id || '').toLowerCase() === r.id
            && liveRoute(sessionServer(x), x.session_id).server === r.server);
        if (!s) return notFound('That agent is not running here', { view: 'agents' });
        switchNavTab('agents', { fromHistory: true });
        const cur = state.currentSession;
        const shown = cur && cur.type === 'live' && cur.session_id === s.session_id && sessionServer(cur) === sessionServer(s);
        if (!shown) await window.selectLiveSession(s.name, s.agent_type, s.session_id, sessionServer(s));
        else if (isPhoneLayout()) showView('live-session-view'); // the phone's Agents tab showed the list
        if (r.sub) switchAgenticTab(r.sub, 'top');
        if (r.terminal) showTerminalView(); // /agents/<session>?view=terminal (coral-hub, #6752): the terminal for this visit; the saved Chat/Terminal choice is left as it was
    });

    route('chats', async (r, opts) => {
        await liveListReady;
        if ((r.server || !isCloud()) && !setHistorySource(r.server || 'local')) return notFound('That computer was not found', { view: 'chats' });
        if (r.id) {
            switchNavTab('history', { fromHistory: true });
            const cur = state.currentSession;
            if (!(cur && cur.type === 'history' && cur.name === r.id && sessionServer(cur) === historyServer()) && (await selectHistorySession(r.id)) === false) {
                state.currentSession = null;
                notFound('That chat was not found', { view: 'chats', query: currentChatsQuery() });
            }
            return;
        }
        // The list: its filters are the URL's (startup already read them). The search box and the filter controls show them on a start too: a local Coral no longer reads the chat list at start (#8195), so nothing else fills them.
        if (!opts.startup) setHistoryPage(deserializeFromUrl().page);
        syncFilterDomToState();
        if (state.currentSession && state.currentSession.type === 'history') state.currentSession = null; // Back closed the chat
        switchNavTab('history', { fromHistory: true });
    });

    for (const sub of ['goals', 'tasks', 'boards']) route('inbox-' + sub, async r => {
        await liveListReady;
        switchNavTab('hub-inbox', { fromHistory: true });
        const m = await importOnce('./inbox_sidebar.js');
        if (currentRoute()?.view !== r.view || currentRoute()?.id !== r.id || currentRoute()?.item !== r.item) return;
        if (r.id && sub === 'goals') await m.openInboxGoal(r.id, r.item);
        else if (r.id) await m.openInboxItem(sub, r.id, r.item);
        else await m.openInboxGroup(sub === 'boards' ? 'chats-group' : sub);
    });

    onRoute('team', async r => {
        await liveListReady;
        switchNavTab('agents', { fromHistory: true });
        await applyTeamRoute(routeKey(r), r.sub || 'goals', r.item || 0, r.query || ''); // the team page (#7453); /team/<name> is its Goals tab
    });

    route('inbox-folder', async r => { // /inbox/<folder> (#8652): the Inbox on that folder; the address stays (the folder notes the same route)
        await liveListReady;
        switchNavTab('hub-inbox', { fromHistory: true, folder: r.folder });
    });

    route('board', async r => { // the old board page is gone (#8061): /board/<team> opens the team page's Messages tab, in its place in the history
        await liveListReady;
        switchNavTab('agents', { fromHistory: true });
        await openTeamPage(routeKey(r), { tab: 'messages', replace: true });
    });

    route('workflows', r => go({ view: 'automations', folder: 'workflows', ...(r.id ? { id: r.id } : {}), ...(r.run ? { run: r.run } : {}) }, { replace: true })); // the old Workflows address: Workflows is a folder of Automations (Goal #74)

    route('jobs', () => go({ view: 'automations', folder: 'jobs' }, { replace: true })); // the old Jobs address: Jobs is a folder of Automations (Goal #74)
    route('automations', async r => { // /automations[/<folder>[/<id>]]: the folder or the job's page it names, the address stays
        switchNavTab('automations', { fromHistory: true });
        const m = await loadAutomations();
        if (await m.openAutomationsRoute(r) === false) notFound(r.folder === 'workflows' ? (r.run ? 'That workflow run was not found' : 'That workflow was not found') : 'That job was not found', { view: 'automations', folder: r.folder });
    });
    route('analytics', r => {
        state.analyticsAsk = { view: r.sub || 'overview', open: !!r.sub }; // the Analytics page the path names (#8606); showViews reads it once the tab has loaded
        switchNavTab('tokens', { fromHistory: true });
    });

    route('docs', async r => {
        switchNavTab('docs', { fromHistory: true });
        (await loadDocs()).openDoc(r.id || null);
    });

    // Servers is the hub's tab (known once the list has loaded); a Coral without one goes home.
    route('servers', async r => {
        await liveListReady;
        const m = await importOnce('./servers_tab.js');
        if (!(await m.openServersTab(r.id || undefined, { fromHistory: true }))) go({ view: 'agents' }, { replace: true });
    });

    // A dashboard page link in agent-written text (#3542 keeps it as a[data-route], rebuilt from
    // the parsed route): a plain click goes through the router instead of reloading the dashboard.
    // A modified or middle click, another origin, or a path the router refuses keeps the browser's.
    document.addEventListener('click', e => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a[data-route][href]');
        if (!a || (a.target && a.target !== '_self')) return;
        let url;
        try { url = new URL(a.getAttribute('href'), location.origin); } catch { return; }
        if (url.origin !== location.origin) return;
        const r = parseRoute(url.pathname, url.search);
        if (!r) return;
        e.preventDefault();
        go(r);
    });

    // A sidebar tab the user picks is part of the page (a replace): an agent's tab, or a team's
    // view or settings. Tabs switched by code (restoring the last one) leave the URL alone.
    document.addEventListener('click', e => {
        const btn = e.target.closest && e.target.closest('#agentic-block-top .agentic-tab');
        if (!btn) return;
        const tab = btn.id.replace('agentic-tab-', '');
        const cur = currentRoute();
        const s = state.currentSession;
        if (cur && cur.view === 'agents' && cur.id && s && s.type === 'live' && AGENT_SUBTABS.includes(tab)) {
            note(liveRoute(sessionServer(s), s.session_id, tab), { replace: true });
        }
    });
}

export function startRoute(popout) {
    // The page's route (#3532): its path, or an old hash link, shown once the handlers are in place.
    if (!popout) {
        registerRouteHandlers();
        // A link to one saved message (#4596): read before the route is written, run once the live list is in.
        const savedLink = START_SEARCH.includes('saved=') ? importOnce('./saved_link.js').then(m => m.parseSavedLink(START_SEARCH, isCloud())).catch(() => null) : null;
        startNav();
        if (savedLink) Promise.all([savedLink, liveListReady]).then(([item]) => item && importOnce('./saved.js').then(m => m.openSavedLink(item))).catch(() => {});
    }
}
