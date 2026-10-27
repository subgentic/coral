/* Agent task bar — CRUD, rendering, drag reorder */

// Load order only (#4996): the imports below with no names are loaded for what the module registers at load, in the order this module imported them before the split (the startup-sequence golden records it).
import './state.js';
import './dock_page.js';
import './dom_morph.js';
import './dialog_close.js';
import { registerTaskView } from './task_hooks.js';
import './utils.js';
import { registerActions, idOf, withId, tokenOf, textOf } from './actions.js';
import { importOnce } from './import_once.js';
import { _getBoardProject } from './task_board_context.js';
import './live_chat.js';
// Load order only (#4996): the imports below with no names are loaded for what the module registers at load, in the order this module imported them before the split (the startup-sequence golden records it).
import './task_verification.js';
import './server_base.js';
import './platform/detect.js';
import './overload.js';
import './task_format.js';
import { showSubagentDetailModal } from './subagents.js';
import './safe_storage.js';
import './lazy_dom.js';
import './tasks_view.js';
import './task_filters.js';
import './task_board_context.js';
import './task_verify_marks.js';
import { _updateDepTags } from './task_dep_picker.js';
import './task_reminders.js';
import { openDockTaskPreview, _boardTaskPollTick, _boardTaskPollTimer, _toggleHideCompleted, _toggleTaskSort, renderBoardTaskList } from './task_list.js';
import { lazyFns, loadTaskDetail } from './lazy_panels.js';
export { boardTaskFetchHooks, boardTaskPollHooks, loadAgentTasks, loadBoardTasks, renderBoardTaskList, renderTaskList, startBoardTaskPoll, stopBoardTaskPoll } from './task_list.js';
export { hideCreateTaskModal, showCreateTaskModal } from './task_create.js';
// The task detail dialog is loaded the first time a task is opened (#5364: 43 KB the page does not need to start). Its functions are stubs until then (lazy_panels.js); closing one that was never opened has nothing to do.
const detail = lazyFns(loadTaskDetail, ['_doCompleteAgentTask', 'completeAgentTask', 'showAgentTaskDetailModal']);
export const { _doCompleteAgentTask, completeAgentTask, showAgentTaskDetailModal } = detail;
export const hideTaskDetailModal = (...a) => (loadTaskDetail.module ? loadTaskDetail.module.hideTaskDetailModal(...a) : undefined);
export { clearOpenSubagent, loadSubagents } from './subagents.js';




document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _boardTaskPollTimer) _boardTaskPollTick();
});






/* ── Board Tasks ────────────────────────────────────────── */


















 


// Expose globally
(window.__coral ||= {})._toggleTaskSort = _toggleTaskSort;












/* ── Dependency Picker ─────────────────────────────────── */


;


/* ── Create Task Modal ─────────────────────────────────── */








/* ── Task Detail Modal ─────────────────────────────────── */





























// What the subagent dialog calls back (task_hooks.js).
registerTaskView({ renderBoardTaskList, hideTaskDetailModal });

// The task list and task dialogs' markup (#3645): data-on-* names, never code. Each action calls
// the same function the inline handler did, after checking its values (a bad one does nothing).
// Cancelling and completing a task still go through their confirm footers (task-cancel shows
// "Yes, Cancel"; task-complete shows the completion form), as before.
const depContainer = el => { const id = tokenOf(el.dataset.container); return id ? document.getElementById(id) : null; };
registerActions({
    'task-close': () => window.hideTaskDetailModal(),
    'task-hide-done': () => _toggleHideCompleted(),
    'task-open': el => withId(el.dataset.taskId, id => (el.dataset.kind === 'agent' ? window.showAgentTaskDetailModal(id) : openDockTaskPreview(id, el))), // standalone agent tasks keep their dialog; board tasks use the shared preview pane (#8788)
    'task-subagent-open': el => { const sid = textOf(el.dataset.subagentId); if (sid) showSubagentDetailModal(sid); },
    'dep-picker-toggle': el => {
        const list = depContainer(el) && document.getElementById(el.dataset.container + '-list');
        if (list) { list.style.display = list.style.display === 'none' ? '' : 'none'; el.setAttribute('aria-expanded', String(list.style.display !== 'none')); }
    },
    'dep-picker-change': el => { if (depContainer(el)) _updateDepTags(el.dataset.container); },
    'dep-tag-remove': el => {
        const box = depContainer(el), id = idOf(el.dataset.taskId);
        if (box && id) box.querySelector(`input[type="checkbox"][value="${id}"]`)?.click();
    },
    'task-goal-open': el => { const id = idOf(el.dataset.goalId), project = _getBoardProject(); if (!id || !project) return; window.hideTaskDetailModal?.(); importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(project, id)); }, // the task's Goal line opens the goal on the Goals face (#7253)
    'task-complete': el => withId(el.dataset.taskId, id => window.completeAgentTask(id)),
    'task-complete-back': el => withId(el.dataset.taskId, id => window.showAgentTaskDetailModal(id)),
    'task-complete-do': el => withId(el.dataset.taskId, id => window._doCompleteAgentTask(id)),
    // A task's coral:// artifact opens in the preview (only an artifact URI; the link doesn't navigate).
    'task-artifact-open': (el, event) => {
        event.preventDefault();
        const uri = el.dataset.artifactUri || '';
        if (!/^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(uri)) return;
        window.hideTaskDetailModal?.();
        window.openFilePreview?.(uri);
    },
});
