/* Initial dashboard data loading and readiness. */

import { importOnce } from './import_once.js';
import { loadUpdatesFlag } from './update_flag.js';
import { dashboardSessionsLoaded, dashboardFailed } from './dashboard_analytics.js';
import { initAgentUI } from './agent_ui.js';

import { loadLiveSessions } from './api.js';
import { deserializeFromUrl } from './search_filters.js';
import { connectCoralWs } from './websocket.js';
import { loadCustomViews } from './custom_views.js';
import { initTabCustomize } from './tab_customize.js';
import { initDockTabs } from './dock_tabs.js';
import { initScheduler } from './scheduler.js';
import { initLiveJobs } from './live_jobs.js';
import { loadAllFolderTags } from './folder_tags.js';
import { loadPinnedFolders } from './pinned_folders.js';
import { initMobile } from './mobile.js';
import { checkForUpdates } from './update_check.js';
import { markReady } from './ready.js';
import { isCloud } from './server_base.js';
import { _startListLoadSettled, pollStartupStatus } from './startup_status.js';
import { setHistoryPage } from './history_state.js';
import { startHistoryList } from './history_filters.js';

export const START_SEARCH = location.search;

function openUpdatesFromLink() {
    const p = new URLSearchParams(START_SEARCH);
    const v = p.getAll('settings');
    if (v.length !== 1 || v[0] !== 'updates') return;
    p.delete('settings');
    const rest = p.toString();
    try { history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch { /* an address that cannot be rewritten stays */ }
    window.showSettingsModal('updates');
}

let _liveListLoaded;

export const liveListReady = new Promise(r => { _liveListLoaded = r; });

export function loadInitialData(popout) {
    // Restore filter state from URL query params before first load
    const restored = deserializeFromUrl();
    setHistoryPage(restored.page);

    // The hash the page was opened with: a deep link to restore. A hash the user
    // sets while the list loads (e.g. opening Servers) is not restored again,
    // which would re-open that view a second time (#3152).
    loadLiveSessions(dashboardFailed).then(ok => {
        markReady('liveList'); // already marked by the render; this covers a failed first load
        dashboardSessionsLoaded(ok);
    }).finally(() => { _startListLoadSettled(); _liveListLoaded(); });
    loadAllFolderTags();
    if (!popout) loadPinnedFolders();
    if (!popout) importOnce('./received_cap_notice.js').then(m => m.checkReceivedCap()).catch(() => {}); // #4441: told once when received files reach 80% of their limit
    if (!popout) importOnce('./terminal_backend.js').then(m => { m.checkTerminalNotices(); m.watchAutoWake(); m.watchHooksStatus(); }).catch(() => {}); // #3634, #3636, #3665
    for (const [n, f] of [['loadCustomViews', loadCustomViews], ['initTabCustomize', initTabCustomize], ['initDockTabs', initDockTabs], ['initAgentUI', initAgentUI]]) { // a failing step must not stop the feed
        const fail = e => console.error(`init step ${n} failed`, e);
        try { Promise.resolve(f()).catch(fail); } catch (e) { fail(e); }
    }
    connectCoralWs();
    if (!popout) checkForUpdates();
    if (!popout) loadUpdatesFlag().then(on => on && importOnce('./update_ui.js').then(m => { m.startUpdateUi(); openUpdatesFromLink(); })).catch(() => {}); // the auto-update control, shown when the server says the updater is on (#5275, #5280)
    pollStartupStatus();
    if (!popout) {
        if (isCloud()) startHistoryList().finally(() => markReady('history')); // the hub's Chats tab; a local Coral reads its chat list when an opened chat that comes without its entry (a link, a saved message) or the Resume dialog wants one (#8195); the Inbox's chat folders read /api/sessions/history with their own type and pass the entry they open
        else markReady('history');
        initScheduler();
        initLiveJobs();
    }
    if (popout) markReady('history'); // a popout has no history list
    initMobile();
}
