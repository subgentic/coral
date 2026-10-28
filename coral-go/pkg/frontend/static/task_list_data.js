/* The pure parts of the dock's task list (moved out of task_list.js, #8386): what a task says about its state, which review it is in, and the order the rows are shown in. Node-tested. */
import { _priorityOrder } from './task_format.js';

/** Whether the completion form offers "Not yet: send back" (#10337): the task has an agent to tell, and the Coral Hub's access for the board's machine allows Interact (hubReason is blockedReason's words, '' when it does). */
export function canSendBack(task, hubReason) {
    return !!(task && task.assigned_to) && !hubReason;
}

/** Whether the task's bar offers Complete (#10337): the task is not blocked or a draft, and the Coral Hub's access for the board's machine allows Interact (the call POST /api/board/{project}/tasks/{id}/complete is an Interact rule in pkg/tunnel/routes.go). hubReason is blockedReason's words, '' when it does. */
export function canComplete(task, hubReason) {
    return !!task && task.status !== 'blocked' && task.status !== 'draft' && !hubReason;
}

/** A list item says review_requested; a full task has workflow.completion_review. */
export function reviewRequested(t) {
    return !!(t && (t.review_requested || t.workflow?.completion_review));
}

/** The sort a list starts with: newest first, no column chosen (open work comes before done work, #4716). */
export const defaultSort = () => ({ field: 'created_at', asc: false, explicit: false, clicks: 0 });

/** The sort after a click on a column header. A column's clicks: the first chooses it, the second turns it round, the third gives the default order back (open work first, #4737). */
export function nextSort(sort, field) {
    if (sort.explicit && sort.field === field) {
        if (sort.clicks + 1 >= 3) return defaultSort();
        return { ...sort, asc: !sort.asc, clicks: sort.clicks + 1 };
    }
    return { field, asc: field === 'priority', explicit: true, clicks: 1 }; // priority defaults asc (critical first)
}

/** The tasks to show: done ones dropped when hidden, in the order the sort object ({ field, asc, explicit }) chooses. */
export function filterAndSortTasks(allTasks, sort, { querying = false, hideCompleted = false } = {}) {
    const isDone = t => t.status === 'completed' || t.status === 'skipped';
    if (querying && !sort.explicit) return allTasks; // the server's order (a search is not cut by Hide done)
    const tasks = allTasks.filter(t => {
        if (!querying && hideCompleted && (t.status === 'completed' || t.status === 'skipped')) return false;
        return true;
    }).sort((a, b) => {
        let cmp = 0;
        if (sort.field === 'created_at') {
            cmp = (a.created_at || '').localeCompare(b.created_at || '');
        } else if (sort.field === 'priority') {
            cmp = (_priorityOrder[a.priority] ?? 2) - (_priorityOrder[b.priority] ?? 2);
        } else if (sort.field === 'assignee') {
            cmp = (a.assigned_to || '').localeCompare(b.assigned_to || '');
        } else if (sort.field === 'cost') {
            const aCost = a.cost_usd ?? -1;
            const bCost = b.cost_usd ?? -1;
            cmp = aCost - bCost;
        } else if (sort.field === 'type') {
            cmp = (a._source || '').localeCompare(b._source || '');
        } else if (sort.field === 'id') {
            cmp = (a.id || 0) - (b.id || 0);
        }
        return sort.asc ? cmp : -cmp;
    });
    // The default order puts open and active work first, then the finished tasks, newest first inside each part (a stable split): with a thousand
    // recent finished tasks the first rows were all Finished (#4716). A column the person chose sorts the whole list as it always did.
    if (!sort.explicit && !querying) return [...tasks.filter(t => !isDone(t)), ...tasks.filter(isDone)];
    return tasks;
}

/** A row's status icon and label. */
export function taskStatus(t) {
    const statusWrap = (className, detail, label) => ({ className, detail, label });
    const activelyClaimed = t.status === 'in_progress' && Boolean(t.claimed_at);
    const workingDetail = activelyClaimed ? 'Claimed · Working' : 'Open · Working';
    const statusIcon = (t.outcome || t.workflow?.outcome) === 'failed'
        ? statusWrap('completed', 'Finished', 'Finished')
        : t.status === 'completed'
        ? statusWrap('completed', 'Finished', 'Finished')
        : t.status === 'review_pending'
        ? statusWrap('blocked', 'Open · Review pending', 'Review')
        : reviewRequested(t) && t.status === 'in_progress'
        ? statusWrap('blocked', 'Open · Review requested', 'Open · Review requested')
        : t.status === 'in_progress'
        ? statusWrap('in-progress', workingDetail, activelyClaimed ? 'Claimed' : 'Open')
        : t.status === 'skipped'
        ? statusWrap('cancelled', 'Cancelled', 'Cancelled')
        : t.status === 'blocked'
        ? statusWrap('blocked', 'Blocked: waiting for prerequisites', 'Blocked')
        : t.status === 'draft'
        ? statusWrap('pending', 'Open · Draft', 'Open · Draft')
        : statusWrap('pending', 'Open', 'Open');
    return statusIcon;
}
