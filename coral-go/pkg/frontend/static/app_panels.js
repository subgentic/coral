/* Lazy dashboard panel adapters shared by navigation, routes, and actions. */

import { lazyFns, loadTeamPage, loadTeamSettings, loadTeamLinkDialog, loadWorkflows, loadCostDashboard, loadDocs, loadThemeConfig, loadModals, loadSettingsDialog, loadResumeDialog, loadDefaultPromptsDialog } from './lazy_panels.js';

export const {
    selectWorkflow, selectWorkflowRun, killWorkflowRun, deleteWorkflow,
    showWorkflowCreateModal, hideWorkflowCreateModal, editWorkflowWithAgent, workflowsBackToList, launchWorkflowAgent,
} = lazyFns(loadWorkflows, ['selectWorkflow', 'selectWorkflowRun', 'killWorkflowRun', 'deleteWorkflow',
    'showWorkflowCreateModal', 'hideWorkflowCreateModal', 'editWorkflowWithAgent', 'workflowsBackToList', 'launchWorkflowAgent']);

export const { showCostDashboard, _refreshCostDashboard, _costTimeRangeChanged } =
    lazyFns(loadCostDashboard, ['showCostDashboard', '_refreshCostDashboard', '_costTimeRangeChanged']);

export const { openTeamPage, applyTeamRoute, exitTeamPage, teamIsMissing } = lazyFns(loadTeamPage, ['openTeamPage', 'applyTeamRoute', 'exitTeamPage', 'teamIsMissing']);

export const { showTeamWorkingModeWorkspace } = lazyFns(loadTeamSettings, ['showTeamWorkingModeWorkspace']);
export const { showTeamLinkDialog } = lazyFns(loadTeamLinkDialog, ['showTeamLinkDialog']);

export const stopCostDashboard = () => { loadCostDashboard.module?.stopCostDashboard(); };

export const { showDocsTab, selectDoc } = lazyFns(loadDocs, ['showDocsTab', 'selectDoc']);

export const { showThemeConfigurator, hideThemeConfigurator } = lazyFns(loadThemeConfig, ['showThemeConfigurator', 'hideThemeConfigurator']);

export const {
    showLaunchModal, hideLaunchModal, launchSession, hideInfoModal, copyInfoCommand,
    toggleFlag, showAddAgentToBoard, launchTerminalToBoard, launchDefaultAgent,
    showAddStandaloneAgent, launchStandaloneTerminal, exportPersonas, importPersonas, importTeamTemplates, exportTeamTemplate,
} = lazyFns(loadModals, [
    'showLaunchModal', 'hideLaunchModal', 'launchSession', 'hideInfoModal', 'copyInfoCommand', 'toggleFlag', 'showAddAgentToBoard', 'launchTerminalToBoard', 'launchDefaultAgent', 'showAddStandaloneAgent', 'launchStandaloneTerminal', 'exportPersonas', 'importPersonas', 'importTeamTemplates', 'exportTeamTemplate']);

export const { showSettingsModal, hideSettingsModal, applySettings } = lazyFns(loadSettingsDialog, ['showSettingsModal', 'hideSettingsModal', 'applySettings']);

export const { showResumeModal, hideResumeModal, resumeLaunchNew } = lazyFns(loadResumeDialog, ['showResumeModal', 'hideResumeModal', 'resumeLaunchNew']);

export const { showDefaultPromptsModal, hideDefaultPromptsModal, resetDefaultPrompt, saveDefaultPrompts } = lazyFns(loadDefaultPromptsDialog, ['showDefaultPromptsModal', 'hideDefaultPromptsModal', 'resetDefaultPrompt', 'saveDefaultPrompts']);
