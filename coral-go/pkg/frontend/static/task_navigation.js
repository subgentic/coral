/* Board tasks have one destination. Standalone agent/subagent tasks are separate entities. */
import { idOf, textOf } from './actions.js';
import { build, keyRoute } from './routes.js';

export function taskHref(project, id) {
    const team = textOf(project), task = idOf(id);
    return team && task ? build(keyRoute('team', team, 'tasks', task)) : '';
}

export function openTask(project, id) {
    const team = textOf(project), task = idOf(id);
    if (!team || !task) return;
    return window.openTeamPage(team, { tab: 'tasks', item: task });
}
