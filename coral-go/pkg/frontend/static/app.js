/* Dashboard entry: preserve dependency evaluation order and start the dashboard. */

import { isPhoneLayout } from './phone_layout.js';
import './update_banner.js';
import './import_once.js';
import './update_flag.js';
import { startChatPrefetch } from './chat_page.js';
import './hub_blocked_controls.js';
import './session_rows.js';
import './settings_rows_boot.js';
import './team_form.js';
import './agent_form.js';
import './branch_expand.js';
import './nav_tabs.js';
import { initPrerequisiteChecks } from './prerequisites.js';
import './system_status.js';
import { beginDashboardAnalytics, dashboardInitialized, dashboardFailed } from './dashboard_analytics.js';
import './agent_ui.js';
import './team_availability.js';
import './state.js';
import './local_store.js';
import './api.js';
import './search_filters.js';
import './websocket.js';
import './controls.js';
import './sessions.js';
import './render.js';
import './capture.js';
import { loadSettings } from './settings_core.js';
import { initEditions } from './editions.js';
import './version_line.js';
import './modal_chrome.js';
import { attachAllDialogFocus } from './dialog_focus.js';
import './board_choice.js';
import './dialog_focus.js';
import './browser.js';
import './sidebar.js';
import './xterm_renderer.js';
import './notes.js';
import './tags.js';
import './tasks.js';
import './changed_files.js';
import './file_mention.js';
import './command_mention.js';
import './agent_notes.js';
import './custom_views.js';
import './tab_customize.js';
import './dock_tabs.js';
import { note } from './nav.js';
import './routes.js';
import { initPopout, applyPopoutBodyClass } from './popout.js';
import './live_chat.js';
import './agentic_state.js';
import { buildWelcome } from './utils.js';
import './preview_pane.js';
import './scheduler.js';
import './job_form.js';
import './live_jobs.js';
import './message_board.js';
import './folder_tags.js';
import './pinned_folders.js';
import './mobile.js';
import './platform/detect.js';
import './platform/native.js';
import './platform/macos.js';
import './platform/windows.js';
import './platform/browser.js';
import './chat_find.js';
import './update_check.js';
import './server_base.js';
import { initServersUi } from './servers.js';
import { initHubIndicator } from './hub_indicator.js';
import './servers_tab.js';
import './inbox_tab.js';
import './group_collapse.js';
import './sidebar_groups.js';
import './display_panel.js';
import './actions.js';
import { markReady } from './ready.js';
import './lazy_panels.js';
import { initCloud } from './cloud.js';
import { isCloud } from './server_base.js';
import { installOverloadWatch } from './overload.js';
import './auth_redirect.js';
import './safe_storage.js';
import './lazy_dom.js';
import './test_hooks.js';
import './team_folder_import.js';
import './sidebar_menus.js';
import './startup_status.js';
import './history_state.js';
import { installFetchShare } from './fetch_share.js';
import { initLocalStore, initPanels, initPlatform, installUnauthorizedRedirect, wireComposer, wirePaneScroll, wireWindowEvents, yieldToMain } from './app_wiring.js';
import { wireHistoryFilters } from './history_filters.js';
import './history_source.js';
import { switchNavTab, showHome } from './app_navigation.js';
import { startRoute } from './app_routes.js';
import { loadInitialData } from './initial_load.js';
// Register actions and hooks after the original entry dependencies have evaluated.
import './app_actions.js';

(window.__coral ||= {})._goHome = function() {
    note({ view: 'agents' });
    showHome();
};

startChatPrefetch({ cloud: isCloud() });

// Started on DOMContentLoaded, or at once when that has already fired: a module graph with a top-level await finishes evaluating after the browser fired it, and a listener added then never ran, so no
// startup ran and a pop-out never took its mode (#8538). A deferred module runs while readyState is "interactive", before DOMContentLoaded, so the state alone does not say it has fired: the page's navigation timing does.
async function startDashboard() {
    beginDashboardAnalytics();
    if (!isPhoneLayout()) buildWelcome(); // a phone starts on the agent list and builds the welcome screen only if it is shown (#4497)
    try {
    initPlatform();
    installFetchShare(); // the same read asked twice at load is one request (#9111); the wrappers below each see every caller's own answer
    installUnauthorizedRedirect();

    // Back off on 429/502/503 (#3403): every poller pauses while Coral (or the hub) is overloaded.
    installOverloadWatch();

    await initCloud();   // no-op unless the page's boot data says mode "cloud"
    await initLocalStore();
    loadSettings().then(initEditions).catch(e => console.error('ways to run Coral:', e)).finally(() => markReady('settings'));
    initServersUi();   // reveals hub-only entry points when /api/health reports hub:true

    // Single-agent popout mode (/agent/{uuid}): chrome-free workspace only.
    // Marked before any renderer runs so CSS and storage scoping apply.
    const popout = applyPopoutBodyClass();
    if (!popout) initHubIndicator(); // the Coral Hub connection in the header (#3544)

    loadInitialData(popout);

    initPrerequisiteChecks();
    attachAllDialogFocus();   // focus in and back for every dialog in the shell (#4026)

    wireHistoryFilters();
    wireComposer();
    wirePaneScroll();
    initPanels();

    // The page's startup was one task of about 60 ms at a 4x slowdown (the bundle's evaluation and every step of this handler, ahead of the first paint). Everything is wired
    // and the requests are out; the browser may paint and answer before the navigation and the route are set up (#4995).
    await yieldToMain();

    // Initialize nav tabs — hide history section on load (Agents tab is default)
    if (!popout) {
        switchNavTab('agents');
    } else {
        initPopout();
    }

    wireWindowEvents();
    startRoute(popout);
    dashboardInitialized();
    } catch (error) {
        dashboardFailed('init_failed');
        throw error;
    }
}

// The page's navigation timing (found by its class: the name of its entry type is also the name of a Material icon, which the icon census reads as a use), else the legacy timing object.
const navigationTiming = () => typeof PerformanceNavigationTiming === 'undefined' ? null : performance.getEntries().find(e => e instanceof PerformanceNavigationTiming);
const domContentLoadedFired = () => document.readyState === 'complete' || (navigationTiming()?.domContentLoadedEventStart ?? performance.timing?.domContentLoadedEventStart ?? 0) > 0;
if (domContentLoadedFired()) startDashboard();
else document.addEventListener('DOMContentLoaded', startDashboard);
