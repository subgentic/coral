/* Lazy dashboard panel adapters shared by navigation, routes, and actions. */

import { lazyFns, loadTeamPage, loadTeamSettings, loadWorkflows, loadCostDashboard, loadDocs, loadThemeConfig, loadModals, loadSettingsDialog, loadResumeDialog, loadDefaultPromptsDialog } from './lazy_panels.js';

export const {
    showWorkflowsTab, selectWorkflow, selectWorkflowRun, killWorkflowRun, deleteWorkflow,
    showWorkflowCreateModal, hideWorkflowCreateModal, editWorkflowWithAgent, workflowsBackToList, launchWorkflowAgent,
} = lazyFns(loadWorkflows, ['showWorkflowsTab', 'selectWorkflow', 'selectWorkflowRun', 'killWorkflowRun', 'deleteWorkflow',
    'showWorkflowCreateModal', 'hideWorkflowCreateModal', 'editWorkflowWithAgent', 'workflowsBackToList', 'launchWorkflowAgent']);

export const { showCostDashboard, _refreshCostDashboard, _costTimeRangeChanged } =
    lazyFns(loadCostDashboard, ['showCostDashboard', '_refreshCostDashboard', '_costTimeRangeChanged']);

export const { openTeamPage, applyTeamRoute, exitTeamPage } = lazyFns(loadTeamPage, ['openTeamPage', 'applyTeamRoute', 'exitTeamPage']);

export const { showTeamWorkingModeWorkspace } = lazyFns(loadTeamSettings, ['showTeamWorkingModeWorkspace']);

export const stopCostDashboard = () => { loadCostDashboard.module?.stopCostDashboard(); };

export const { showDocsTab, selectDoc } = lazyFns(loadDocs, ['showDocsTab', 'selectDoc']);

export const { showThemeConfigurator, hideThemeConfigurator } = lazyFns(loadThemeConfig, ['showThemeConfigurator', 'hideThemeConfigurator']);

export const {
    showLaunchModal, hideLaunchModal, launchSession, hideInfoModal, copyInfoCommand,
    toggleFlag, showAddAgentToBoard, launchTerminalToBoard, launchDefaultAgent,
    showAddStandaloneAgent, launchStandaloneTerminal, exportPersonas, importPersonas, importTeamTemplates,
} = lazyFns(loadModals, [
    'showLaunchModal', 'hideLaunchModal', 'launchSession', 'hideInfoModal', 'copyInfoCommand', 'toggleFlag', 'showAddAgentToBoard', 'launchTerminalToBoard', 'launchDefaultAgent', 'showAddStandaloneAgent', 'launchStandaloneTerminal', 'exportPersonas', 'importPersonas', 'importTeamTemplates']);

export const { showSettingsModal, hideSettingsModal, applySettings } = lazyFns(loadSettingsDialog, ['showSettingsModal', 'hideSettingsModal', 'applySettings']);

export const { showResumeModal, hideResumeModal, resumeLaunchNew } = lazyFns(loadResumeDialog, ['showResumeModal', 'hideResumeModal', 'resumeLaunchNew']);

export const { showDefaultPromptsModal, hideDefaultPromptsModal, resetDefaultPrompt, saveDefaultPrompts } = lazyFns(loadDefaultPromptsDialog, ['showDefaultPromptsModal', 'hideDefaultPromptsModal', 'resetDefaultPrompt', 'saveDefaultPrompts']);
