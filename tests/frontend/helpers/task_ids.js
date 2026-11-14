// Task ids come from one counter for the whole server, so a suite that needs "a task that is not there" cannot name a fixed number: on a shard that has run a few dozen suites the task the suite itself creates is that number (#16403: task_link_missing_browser opened its own task 77, the Windows gate's 26th suite in a shard, and the not-found view never showed).
'use strict';

/** An id no task of this server has or will have in a suite's lifetime: one past a task the suite just made, by a million. */
const goneId = created => Number(created) + 1000000;

/** Make the next task id on this server `target` by creating throwaway tasks on `board` until the counter is just below it (a long shard's counter, on demand; nothing to do when it is already past). */
async function advanceCounterTo(api, board, target) {
    for (let i = 0; i < target + 5; i++) {
        const r = await api('POST', `/api/board/${board}/tasks`, { created_by: 'Orchestrator', title: 'filler ' + i, body: 'x', priority: 'low', assigned_to: 'Orchestrator' });
        const id = Number((r.body && (r.body.id || (r.body.task && r.body.task.id))) || 0);
        if (!id || id >= target - 1) return id;
    }
    return 0;
}

module.exports = { goneId, advanceCounterTo };
