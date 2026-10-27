/* Task content inside the shared file/artifact preview pane. */
import { importOnce } from './import_once.js';
export async function mountTaskPreview(body, tab, hooks) {
    const { readTask, renderTaskPage } = await importOnce('./team_tasks_page.js');
    if (!hooks.current()) return;
    const task = await readTask(tab.project, tab.taskId);
    if (!hooks.current()) return;
    if (!task) { body.textContent = 'This task is unavailable.'; return; }
    const host = document.createElement('div');
    body.replaceChildren(host);
    body._taskPreviewDispose = () => { host._taskConversation?.destroy({ keepDrafts: true }); host.replaceChildren(); };
    hooks.title(task.title);
    renderTaskPage(host, task, {
        project: tab.project, backLabel: 'Tasks', onBack: hooks.close, focusBack: true,
        openGoal: id => importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(tab.project, id)),
    });
}
