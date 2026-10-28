/* Dashboard action registrations, public window hooks, and menu event wiring. */

import { importOnce, loadedModule } from './import_once.js';
import { showTeamAvailabilityWorkspace } from './team_availability.js';
import { state } from './state.js';
import { loadLiveSessions } from './api.js';
import { restartSession, restartStage, hideRestartModal, confirmRestart, editGoal, refreshGoal } from './controls.js';
import { selectLiveSession, selectHistorySession, editAndResubmit, renameAgent, editInstructions, setAgentIcon, toggleChatFlag } from './sessions.js';
import { RESET_LOG_NOTE, toggleGroupCollapse, killGroup, killBoard, toggleTeamSleep, toggleAgentSleep, toggleAgentArchive, toggleArchivedSection, shareAgentTeam, saveTeamFromSidebar, killSessionDirect, showInfoDirect, attachDirect, restartDirect, restartSameDirect, showConfirmModal, hideConfirmModal, showPromptModal, hidePromptModal, showAlertModal, hideAlertModal, copyFolderPath, moveGroupUp, moveGroupDown, toggleGroupByTeam, expandSleepingGroup, setBoardAccentColor, moveSessionUp, moveSessionDown, showTeamTokenUsage, distillTeamKnowledge, filterLiveAgents, syncDisplayMenu, agentSearchKey, toggleShowServer, toggleGroupByServer, groupHeaderKey, teamHeaderKey } from './render.js';
import { WHAT_STAYS_RESET } from './agent_words.js';
import { toggleBrowser, browserNavigateTo, browserNavigateUp, browserSelectRecent, browserUse } from './browser.js';
import { toggleAgenticPanel, toggleSidebarRail, focusSidebarSearch } from './sidebar.js';
import { connectTerminalWs, disconnectTerminalWs } from './xterm_renderer.js';
import { saveNotes, generateSummary, toggleNotesEdit, cancelNotesEdit, switchHistoryTab } from './notes.js';
import { addTagToSession, removeTagFromSession, showTagDropdown, hideTagDropdown, createTag } from './tags.js';
import { hideTaskDetailModal, showCreateTaskModal, hideCreateTaskModal, completeAgentTask, _doCompleteAgentTask, showAgentTaskDetailModal } from './tasks.js';
import { openFilePreview, openFileEdit, refreshChangedFiles, copyFilePath } from './changed_files.js';
import { activateCustomView } from './custom_views.js';

import { popoutRetry } from './popout.js';
import { setLiveViewMode, showTerminalView, showChatView } from './live_chat.js';
import { switchAgenticTab } from './agentic_state.js';
import { copyBranchName, showToast } from './utils.js';
import { selectBoardProject, postBoardMessage, deleteMessageBoardProject, toggleBoardPause, showExportBoardModal, toggleSelectMode } from './message_board.js';
import { showFolderTagDropdown, addFolderTag, removeFolderTag, createAndAddFolderTag } from './folder_tags.js';
import { pinFolder, unpinFolder, showOpenFolderModal, hideOpenFolderModal, submitOpenFolder } from './pinned_folders.js';
import { checkForUpdates, dismissUpdateToast } from './update_check.js';
import { teamFetch, keyLabel, nativeInbox } from './server_base.js';
import { showServersModal } from './servers.js';
import { toggleAllGroups } from './group_collapse.js';
import { toggleAllGroupFolds } from './sidebar_groups.js';
import { toggleDisplayPanel, displayPanelKey } from './display_panel.js';
import { registerActions, tokenOf } from './actions.js';
import { lazyWindowFns, loadModals } from './lazy_panels.js';
import { installTestHooks } from './test_hooks.js';
import { _handleTeamFolderImport, _importTeamFromFolder } from './team_folder_import.js';
import { closeSidebarKebabs, closeTopBarSettings, toggleSidebarKebab, toggleTopBarSettings } from './sidebar_menus.js';
import { loadHistoryPage } from './history_filters.js';
import { switchNavTab } from './app_navigation.js';
import { selectWorkflow, selectWorkflowRun, showWorkflowCreateModal, hideWorkflowCreateModal, launchWorkflowAgent, showCostDashboard, _refreshCostDashboard, _costTimeRangeChanged, openTeamPage, exitTeamPage, showTeamWorkingModeWorkspace, showTeamLinkDialog, showDocsTab, selectDoc, showThemeConfigurator, hideThemeConfigurator, showLaunchModal, hideLaunchModal, launchSession, hideInfoModal, copyInfoCommand, showSettingsModal, hideSettingsModal, applySettings, toggleFlag, showAddAgentToBoard, launchTerminalToBoard, launchDefaultAgent, showAddStandaloneAgent, launchStandaloneTerminal, exportPersonas, importPersonas, importTeamTemplates, exportTeamTemplate, showResumeModal, hideResumeModal, resumeLaunchNew, showDefaultPromptsModal, hideDefaultPromptsModal, resetDefaultPrompt, saveDefaultPrompts } from './app_panels.js';
import { MENU_KEYS, menuMove } from './menu_keys.js';

// The New job form (job_form.js, about 28 KB) loads when a person first opens it, not at start (#10218): these are the same calls, answered once the file is in.
const jobForm = () => importOnce('./job_form.js', 'the job form');
const showJobModal = (...args) => jobForm().then(m => m.showJobModal(...args)).catch(() => {}); // a failed load already said so (importOnce's toast): the click is not silent and nothing is left unhandled
// hiding or showing again a form that was never opened has nothing to do, so these do not load it (#10218 review)
const hideJobModal = (...args) => loadedModule('./job_form.js')?.hideJobModal(...args);
const reshowJobModal = (...args) => loadedModule('./job_form.js')?.reshowJobModal(...args);

registerActions({
    'mb-select-mode': () => toggleSelectMode(),
    'mb-export': () => showExportBoardModal(),
    'mb-pause': () => toggleBoardPause(),
    'mb-delete-board': () => deleteMessageBoardProject(),
    'mb-post': () => postBoardMessage(),
    // Enter sends, Shift+Enter is a new line.
    'mb-post-key': (el, event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); postBoardMessage(); } },
});

registerActions({
    'flag-toggle': el => {
        const input = tokenOf(el.dataset.flagInput), flag = el.dataset.flag || '';
        if (input && /^--[a-z0-9-]+$/.test(flag)) window.toggleFlag(input, flag);
    },
    'flag-perm': el => {
        const input = tokenOf(el.dataset.flagInput), type = tokenOf(el.dataset.agentType), mode = tokenOf(el.dataset.mode);
        if (input && type && mode) window._setPermFlagsForInput(input, type, mode);
    },
    'flag-agent-change': el => { if (window._updatePermFlagButtons) window._updatePermFlagButtons(el); },
});

registerActions({
    'm-apply-settings': el => { window.applySettings(); },
    'm-browser-navigate-up': el => { window.browserNavigateUp(); },
    'm-browser-use': el => { window.browserUse(); },
    'm-confirm-restart': el => { window.confirmRestart(); },
    'm-confirm-save-template': el => { window._confirmSaveTemplate(); },
    'm-copy-info-command': el => { window.copyInfoCommand(); },
    'm-export-personas': el => { window.exportPersonas(); },
    'm-generate-team-from-wizard': el => { window.generateTeamFromWizard(); },
    'm-handle-team-folder-import': el => { _handleTeamFolderImport(el); },
    'm-hide-confirm-modal': el => { window.hideConfirmModal(); },
    'm-hide-default-prompts-modal': el => { window.hideDefaultPromptsModal(); },
    'm-hide-info-modal': el => { window.hideInfoModal(); },
    'm-hide-launch-modal': el => { window.hideLaunchModal(); },
    'm-hide-launch-modal-then-show-job-modal': el => { window.hideLaunchModal(); window.showJobModal(); },
    'm-hide-mobile-connect-modal': el => { window._hideMobileConnectModal(); },
    'm-hide-open-folder-modal': el => { window.hideOpenFolderModal(); },
    'm-hide-prompt-modal': el => { window.hidePromptModal(); },
    'm-dialog-step': el => { if (['persona', 'agent', 'next', 'back'].includes(el.dataset.arg)) restartStage(el.dataset.arg); }, // Restart's Next and Back: the name carries no "restart" so the popout's destructive-control scan (agent_popout) does not count them
    'm-hide-restart-modal': el => { window.hideRestartModal(); },
    'm-hide-resume-modal': el => { window.hideResumeModal(); },
    'm-hide-save-template-modal': el => { window._hideSaveTemplateModal(); },
    'm-hide-settings-modal': el => { window.hideSettingsModal(); },
    'm-hide-settings-modal-then-show-default-prompts-modal': el => { window.hideSettingsModal(); window.showDefaultPromptsModal(); },
    'm-hide-settings-modal-then-show-theme-configurator': el => { window.hideSettingsModal(); window.showThemeConfigurator(); },
    'm-hide-task-detail-modal': el => { window.hideTaskDetailModal(); },
    'm-hide-team-wizard-modal': el => { window.hideTeamWizardModal(); },
    'm-hide-view-modal': el => { window._hideViewModal(); },
    'm-import-personas': el => { window.importPersonas(); },
    'm-import-team-from-folder': el => { _importTeamFromFolder(); },
    'm-import-team-templates': el => { window.importTeamTemplates(); },
    'm-export-team-template': el => { window.exportTeamTemplate(document.getElementById('team-template-select')?.value || ''); }, // the saved template that is picked (#10366)
    'm-launch-session': el => { window.launchSession(); },
    'm-launch-team': el => { window.launchTeam(); },
    'm-mobile-connect-backdrop': (el, event) => { if (event.target === el) window._hideMobileConnectModal(); },
    'm-mobile-connect-copy': el => { const u = document.getElementById('mobile-connect-url'); if (!u) return; navigator.clipboard.writeText(u.textContent); el.textContent = 'Copied!'; setTimeout(() => { el.textContent = 'Copy'; }, 1500); },
    'm-on-agent-board-change': el => { window._onAgentBoardChange(); },
    'm-on-launch-server-change': el => { window._onLaunchServerChange(el.value); },
    'm-open-folder-backdrop': (el, event) => { if (event.target === el) window.hideOpenFolderModal(); },
    'm-open-folder-key': (el, event) => { if (event.key === 'Enter') { event.preventDefault(); window.submitOpenFolder(); } },
    'm-perm-mode-describe': el => { if (window._updatePermModeDescription) window._updatePermModeDescription(el); },
    'm-reset-default-prompt': el => { if (["orchestrator", "team_orchestrator", "team_worker", "worker"].includes(el.dataset.arg)) { window.resetDefaultPrompt(el.dataset.arg); } },
    'm-resume-launch-new': el => { window.resumeLaunchNew(); },
    'm-save-current-persona': el => { window._saveCurrentPersona(); },
    'm-save-default-prompts': el => { window.saveDefaultPrompts(); },
    'm-save-team-member': el => { window.saveTeamAgentFromModal(); },
    'm-save-team-template': el => { window._saveTeamTemplate(); },
    'm-save-view': el => { window._saveView(); },
    'm-agent-step': el => { if (['folder', 'persona', 'agent', 'details', 'next', 'back'].includes(el.dataset.arg)) window._launchStage(el.dataset.arg); },
    'm-select-launch-type': el => { if (["agent", "back", "team", "terminal"].includes(el.dataset.arg)) { window._selectLaunchType(el.dataset.arg); } },
    'm-show-mobile-connect-modal': el => { window._showMobileConnectModal(); },
    'm-show-open-folder-modal': el => { window.showOpenFolderModal(); },
    'm-show-team-agent-modal': el => { window.showTeamAgentModal(); },
    'm-show-team-wizard-modal': el => { window.showTeamWizardModal(); },
    'm-submit-open-folder': el => { window.submitOpenFolder(); },
    'm-test-team-wizard': el => { window.testTeamWizard(); },
    'm-toggle-browser': el => { const ids = String(el.dataset.browser || '').split(' '); if (ids.length === 4 && ids.every(i => /^[a-z0-9-]+$/.test(i))) window.toggleBrowser(...ids); },
    'm-toggle-group-by-team': el => { window.toggleGroupByTeam(); },
    'm-validate-team-name': () => { if (window._validateTeamName) window._validateTeamName(); },
    'm-verify-all-c-l-is': el => { window._verifyAllCLIs(); },
});

registerActions({
    'docs-search-filter': el => { const v = el.value; importOnce('./docs.js').then(m => m.filterDocs(v)).catch(() => {}); }, // the Docs sidebar's search box is in the page from the start; docs.js loads with the Docs tab
    'docs-phone-back': () => { importOnce('./docs.js').then(m => m.docsPhoneBack()).catch(() => {}); },
    'docs-copy-agent-line': () => { importOnce('./docs.js').then(m => m.copyDocsLine()).catch(() => {}); }, // the Docs page's button, in the page from the start; docs.js loads with the Docs tab
    'm-close-top-bar-settings-then-check-for-updates': () => { window.__coral.closeTopBarSettings(); window.checkForUpdates(true); },
    'm-close-top-bar-settings-then-show-servers-modal': () => { window.__coral.closeTopBarSettings(); window.showServersModal(); },
    'm-close-top-bar-settings-then-show-settings-modal': () => { window.__coral.closeTopBarSettings(); window.showSettingsModal(); },
    'm-close-top-bar-settings-then-show-shortcuts': () => { window.__coral.closeTopBarSettings(); importOnce('./shortcuts.js').then(m => m.showShortcuts()); },
    'm-close-top-bar-settings-then-show-theme-configurator': () => { window.__coral.closeTopBarSettings(); window.showThemeConfigurator(); },
    'm-close-top-bar-settings-then-stop-all-auto-accept': () => { window.__coral.closeTopBarSettings(); window.stopAllAutoAccept(); },
    'm-dismiss-auto-wake': () => { window.dismissAutoWake(); },
    'm-end-leftover-tmux': () => { window.endLeftoverTmux(); },
    'm-dismiss-default-notice': () => { importOnce('./terminal_backend.js').then(m => m.dismissDefaultNotice()); },
    'm-open-terminal-settings': () => { window.showSettingsModal('terminal'); },
    'm-go-home': () => { window.__coral._goHome(); },
    'm-mobile-connect-open': (el, event) => { event.preventDefault(); window._showMobileConnectModal(); },
    'm-show-launch-modal-then-select-launch-type': el => { if (["agent", "team"].includes(el.dataset.arg)) { window.showLaunchModal(); window._selectLaunchType(el.dataset.arg); } },
    'm-switch-mobile-tab': el => { if (["agents", "board", "chat"].includes(el.dataset.arg)) { window.switchMobileTab(el.dataset.arg); } },
    'm-switch-nav-tab': el => { if (["agents", "artifacts", "automations", "board", "docs", "history", "hub-inbox", "servers", "tokens"].includes(el.dataset.arg)) { window.switchNavTab(el.dataset.arg); } },
    'm-tmux-banner-close': () => { const b = document.getElementById('tmux-missing-banner'); if (b) b.style.display = 'none'; },
    'm-toggle-agentic-panel': () => { window.toggleAgenticPanel(); },
    'm-toggle-tablet-sidebar': () => { window.toggleTabletSidebar(); },
    'm-toggle-top-bar-settings': (el, event) => { window.__coral.toggleTopBarSettings(event); },
    'm-wake-pending-agents': () => { window.wakePendingAgents(); },
});

registerActions({
    'sidebar-rail-toggle': () => window.toggleSidebarRail(),
    'sidebar-search-focus': () => focusSidebarSearch(),
    'launch-show': () => window.showLaunchModal(),
    'agent-search-filter': el => window.filterLiveAgents(el.value),
    'search-all-chats': () => { const q = (document.getElementById('agent-search-input')?.value || '').trim(); if (q) importOnce('./inbox_tab.js').then(async m => { window.switchNavTab('hub-inbox'); await m.selectInboxTab('chats'); await m.searchInboxFolder(q); const box = document.getElementById('agent-search-input'); if (box) { box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); } /* the words moved to the chats search: the Agents box is empty again when the person goes back (#10512) */ }); }, // the sidebar's search words, as a search of every chat: Inbox > All chats with the words in its box and the list read with them (#10050, #10263)
    'agent-search-key': (el, event) => window.agentSearchKey(event),
    'groups-toggle-all': el => { const kind = el.closest('.sidebar-pane')?.dataset.pane; if (kind && kind !== 'agents') toggleAllGroupFolds(kind); else toggleAllGroups(); }, // each tab's header folds its own groups (#7443)
    'display-panel-toggle': el => toggleDisplayPanel(el),
    'display-panel-key': (el, event) => displayPanelKey(event),
    'toggle-show-server': () => window.toggleShowServer(),
    'toggle-group-by-server': () => window.toggleGroupByServer(),
});

const AGENTIC_TABS = new Set(['board', 'files', 'browse', 'artifacts', 'tasks', 'notes', 'activity', 'agent-ui', 'saved']);

registerActions({
    'mobile-back': () => window.mobileBack(),
    'goal-refresh': () => window.refreshGoal(),
    'goal-edit': () => window.editGoal(),
    'live-view-mode': el => { if (el.dataset.mode === 'chat' || el.dataset.mode === 'terminal') window.setLiveViewMode(el.dataset.mode); },
    'chat-find-toggle': () => window.toggleChatFind(),
    'agentic-panel-toggle': el => (el.dataset.open === '0' ? window.toggleAgenticPanel(false) : window.toggleAgenticPanel()),
    'agentic-tab': el => { if (AGENTIC_TABS.has(el.dataset.tab)) window.switchAgenticTab(el.dataset.tab, 'top'); },
    'session-restart': () => window.restartSession(),
    'popout-retry': () => window.popoutRetry(),
    'files-refresh': () => window.refreshChangedFiles(),
    'task-create-show': () => window.showCreateTaskModal(),
});

const HISTORY_TABS = new Set(['notes', 'chat', 'activity', 'tasks', 'agent-notes', 'commits', 'changes']);

registerActions({
    'copy-branch': el => copyBranchName(el),
    'tag-dropdown-show': () => showTagDropdown(),
    'tag-dropdown-hide': () => hideTagDropdown(),
    'tag-create': () => createTag(),
    'summary-generate': () => generateSummary(),
    'resume-show': () => showResumeModal(),
    'history-flag': el => toggleChatFlag(el.dataset.flag),
    'history-details': el => { const id = document.getElementById('history-session-id'); if (!id) return; id.hidden = !id.hidden; el.setAttribute('aria-expanded', String(!id.hidden)); el.textContent = id.hidden ? 'Details' : 'Hide details'; },
    'history-list': () => {
        state.currentSession = null;
        switchNavTab('history');
        document.getElementById('history-search')?.focus();
    },
    'history-tab': el => { if (HISTORY_TABS.has(el.dataset.tab)) switchHistoryTab(el.dataset.tab); },
    'notes-edit': () => toggleNotesEdit(),
    'notes-cancel': () => cancelNotesEdit(),
    'notes-save': () => saveNotes(),
});

registerActions({
    'analytics-search-filter': el => { const v = el.value; importOnce('./analytics_views.js').then(m => m.filterViews(v)).catch(() => {}); }, // the Analytics sidebar's search box is in the page from the start; the views module loads with the tab
    'analytics-view': el => { const key = el.dataset.view; importOnce('./analytics_views.js').then(m => m.selectView(key, { focus: true })).catch(() => {}); },
    'analytics-phone-back': () => { importOnce('./analytics_views.js').then(m => m.phoneBack()).catch(() => {}); },
    'automations-search-filter': el => { const v = el.value; importOnce('./automations.js').then(m => m.filterAutomations(v)).catch(() => {}); }, // the Automations sidebar's search box is in the page from the start; automations.js loads with the tab
    'inbox-search-filter': el => { if (nativeInbox()) return; /* the Hub-served Inbox searches on Enter (inbox_sidebar.js) */ const v = el.value; importOnce('./inbox_sidebar.js').then(m => m.filterInbox(v)).catch(() => {}); }, // the Inbox sidebar's search box is in the page from the start; inbox_sidebar.js loads with the tab
    'wf-build-agent': () => launchWorkflowAgent(),
    'wf-build-agent-from-form': () => { hideWorkflowCreateModal(true); launchWorkflowAgent(); }, // the New workflow form's hint
    'wf-create': () => showWorkflowCreateModal(),
    'job-create-workflow': () => { hideJobModal(); showWorkflowCreateModal(reshowJobModal); }, // New job with no workflow to run
    'wf-modal-backdrop': (el, event) => { if (event.target === el) hideWorkflowCreateModal(); },
});

registerActions({
    'cost-time-range': () => _costTimeRangeChanged(),
    'cost-refresh': () => _refreshCostDashboard({ force: true }), // the Refresh button reads again, whatever a view switch reused (#9250)
});

Object.assign(window, lazyWindowFns(loadModals, ['_selectLaunchType', '_showMobileConnectModal']));

installTestHooks();

Object.assign(window, {
    // api
    _coralLoadLiveSessions: loadLiveSessions,
    // test hooks (tests/frontend): inject a live-sessions payload and render it;
    // feed a /ws/coral message through the real handler without a socket.
    // popout (/agent/{uuid}) + multi-window ownership
    popoutRetry, 
    
    // controls
    restartSession,
    editGoal, refreshGoal,
    hideRestartModal, confirmRestart, 
    // modals
    showSettingsModal, hideSettingsModal, applySettings,
    showDefaultPromptsModal, hideDefaultPromptsModal, resetDefaultPrompt, saveDefaultPrompts,
    showLaunchModal, hideLaunchModal, launchSession, toggleFlag,
    hideInfoModal, copyInfoCommand,
    hideResumeModal, resumeLaunchNew,
    showAddAgentToBoard, launchTerminalToBoard,
    launchDefaultAgent, showAddStandaloneAgent, launchStandaloneTerminal,
    exportPersonas, importPersonas, importTeamTemplates, exportTeamTemplate,
    // sessions
    selectLiveSession, selectHistorySession, editAndResubmit, renameAgent, editInstructions, setAgentIcon,
    // xterm
    connectTerminalWs, disconnectTerminalWs,
    // notes
    // tags
    addTagToSession, removeTagFromSession, 
    // changed_files
    openFilePreview, openFileEdit, refreshChangedFiles,
    copyFilePath, 
    // tasks
    hideTaskDetailModal,
    showCreateTaskModal, hideCreateTaskModal,
    completeAgentTask, _doCompleteAgentTask, showAgentTaskDetailModal,
    // agent_notes
    // agentic_state
    switchAgenticTab,
    // live_chat
    setLiveViewMode, showTerminalView, showChatView,
    // scheduler
    showJobModal, hideJobModal,
    // preview_pane
    // sidebar
    toggleAgenticPanel, toggleSidebarRail,
    // browser
    toggleBrowser, browserNavigateTo, browserNavigateUp, browserSelectRecent, browserUse,
    // theme
    showThemeConfigurator, hideThemeConfigurator,
    // servers (hub mode)
    showServersModal,
    // update_check
    checkForUpdates, dismissUpdateToast,
    // pinned folders (#3630)
    pinFolder, unpinFolder, showOpenFolderModal, hideOpenFolderModal, submitOpenFolder,
    // terminal backend (#3634): the banner's End them, loaded on first use
    endLeftoverTmux: () => importOnce('./terminal_backend.js').then(m => m.endLeftoverTmux()),
    // auto-wake (#3636): the over-the-cap banner's two buttons
    wakePendingAgents: () => importOnce('./terminal_backend.js').then(m => m.wakePendingAgents()),
    dismissAutoWake: () => importOnce('./terminal_backend.js').then(m => m.dismissAutoWake()),
    // message_board
    selectBoardProject,
    // workflows
    selectWorkflow, selectWorkflowRun,
    // cost_dashboard
    showCostDashboard, 
    // docs
    showDocsTab, selectDoc,
    // folder_tags
    showFolderTagDropdown, addFolderTag, removeFolderTag, createAndAddFolderTag,
    // utils
    // router
    _activateCustomView: activateCustomView, 
    // render (pagination)
    loadHistoryPage,
    // top nav
    switchNavTab,
});

function resetTeam(boardName) {
    showConfirmModal('Reset team', `Reset all agents in "${keyLabel(boardName)}"? Each one stops and starts again from its first instructions, in a new chat. ${WHAT_STAYS_RESET} ${RESET_LOG_NOTE}`, async () => {
        try {
            const resp = await teamFetch(boardName, n => `/api/sessions/live/team/${encodeURIComponent(n)}/reset`, { method: 'POST' });
            if (resp.ok) {
                showToast(`Team "${keyLabel(boardName)}" is resetting...`);
            } else {
                const data = await resp.json().catch(() => ({}));
                showToast(data.error || 'Reset failed', true);
            }
        } catch {
            showToast('Reset failed', true);
        }
    }, undefined, { label: 'Reset team', danger: true });
}

window.toggleSendMenu = function(btn, event) {
    const menu = btn.parentElement.querySelector('.send-btn-menu');
    if (!menu) return;
    const show = menu.style.display === 'none';
    menu.style.display = show ? '' : 'none';
    btn.setAttribute('aria-expanded', String(show));
    if (show && event && event.detail === 0) menu.querySelector('.send-menu-item')?.focus(); // opened by the keyboard (Enter or Space): the focus goes in (#9116)
    if (show) {
        const close = (e) => {
            if (!menu.contains(e.target) && !btn.contains(e.target)) {
                menu.style.display = 'none';
                btn.setAttribute('aria-expanded', 'false');
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    }
};

window.closeSendMenu = function() {
    document.querySelectorAll('.send-btn-menu').forEach(m => m.style.display = 'none');
    document.querySelectorAll('[data-on-click="cmd-send-menu"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
};
// The chevron's menu keyboard (#9116): the arrows and Home/End move among its entries; ArrowDown and ArrowUp on the chevron open it on its first or last entry.
document.addEventListener('keydown', e => {
    if (!MENU_KEYS.has(e.key)) return;
    const menu = e.target.closest?.('.send-btn-menu'), chevron = e.target.closest?.('[data-on-click="cmd-send-menu"]');
    if (!menu && !(chevron && e.key !== 'Home' && e.key !== 'End')) return;
    const host = (menu || chevron).parentElement, panel = host.querySelector('.send-btn-menu');
    if (!panel) return;
    e.preventDefault();
    if (chevron && panel.style.display === 'none') window.toggleSendMenu(chevron);
    const items = [...panel.querySelectorAll('.send-menu-item')].filter(x => x.getClientRects().length);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    items[menuMove(e.key, items.length, chevron && !menu ? -1 : at)].focus();
});
// Escape closes the chevron's menu and the focus goes back to the chevron (#9021)
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.send-btn-menu')].find(m => m.style.display !== 'none' && m.getClientRects().length);
    if (!open) return;
    window.closeSendMenu();
    open.parentElement.querySelector('[data-on-click="cmd-send-menu"]')?.focus();
});

document.addEventListener('keydown', e => {
    const menu = e.target.closest?.('.sidebar-kebab-menu');
    if (!menu) return;
    const items = [...menu.querySelectorAll('.overflow-menu-item')];
    const at = items.indexOf(document.activeElement);
    const to = menuMove(e.key, items.length, at);
    if (to >= 0) { e.preventDefault(); items[to].focus(); }
}, true);

document.addEventListener('focusout', e => {
    const wrap = e.target.closest?.('.sidebar-kebab-wrapper');
    if (!wrap || !document.hasFocus()) return;
    const to = e.relatedTarget;
    if (to && wrap.contains(to)) return;
    const menu = wrap.querySelector('.sidebar-kebab-menu');
    if (menu && menu.style.display !== 'none') closeSidebarKebabs();
});

Object.assign(window, {
    toggleSidebarKebab, closeSidebarKebabs,
    // render (sidebar actions)
    filterLiveAgents, agentSearchKey, syncDisplayMenu,
    toggleShowServer, toggleGroupByServer,
    toggleGroupCollapse, groupHeaderKey, teamHeaderKey, killGroup, moveGroupUp, moveGroupDown,
    copyFolderPath, killBoard, setBoardAccentColor, resetTeam,
    moveSessionUp, moveSessionDown,
    toggleTeamSleep, toggleAgentSleep, toggleAgentArchive, toggleArchivedSection,
    exitTeamPage, openTeamPage,
    showTeamAvailabilityWorkspace, showTeamWorkingModeWorkspace, showTeamLinkDialog,
    shareAgentTeam, saveTeamFromSidebar, showTeamTokenUsage, distillTeamKnowledge,
    showConfirmModal, hideConfirmModal, showPromptModal, hidePromptModal, showAlertModal, hideAlertModal,
    killSessionDirect, showInfoDirect, attachDirect, restartDirect, restartSameDirect,
    toggleGroupByTeam, expandSleepingGroup,
    // template_browser
});

(window.__coral ||= {}).toggleTopBarSettings = toggleTopBarSettings;

(window.__coral ||= {}).closeTopBarSettings = closeTopBarSettings;

document.addEventListener('click', (e) => {
    const item = e.target.closest?.('#top-bar-settings-menu .overflow-menu-item');
    if (!item) return;
    const a = document.activeElement;
    if (a && a !== document.body && !item.parentElement.contains(a)) return;
    document.querySelector('[aria-controls="top-bar-settings-menu"]')?.focus({ preventScroll: true });
}, true);

document.addEventListener('click', (e) => {
    if (!e.target.closest('.top-bar-settings-wrapper')) {
        closeTopBarSettings();
    }
    if (!e.target.closest('.sidebar-kebab-wrapper')) {
        closeSidebarKebabs();
    }
});
