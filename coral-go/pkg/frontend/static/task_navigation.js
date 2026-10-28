/* Board tasks have one destination. Standalone agent/subagent tasks are separate entities. */
import { idOf, textOf } from './actions.js';
import { build, keyRoute } from './routes.js';
import { go } from './nav.js';
import { importOnce } from './import_once.js';
import { state } from './state.js';

export function taskHref(project, id) {
    const team = textOf(project), task = idOf(id);
    return team && task ? build(keyRoute('team', team, 'tasks', task)) : '';
}

/** Opens a board task where the click was. `from` is the element clicked: inside the Inbox the task opens in the Inbox (/inbox/tasks/<team>/<id>, Back returns to the screen it came from), anywhere else on the team page (#8861). */
export function openTask(project, id, from, { from: title = '' } = {}) {
    const team = textOf(project), task = idOf(id);
    if (!team || !task) return;
    // Inside an agent's view (its dock's Board tab) the task opens in the side preview beside the agent, as the dock's own tasks do (#8838): the agent's chat stays where it is, and closing the preview returns the keyboard to the button (#10685)
    if (from && from.closest && from.closest('#agentic-panel-board') && state.currentSession && state.currentSession.type === 'live') {
        return importOnce('./preview_pane.js').then(m => m.openTaskPreview(team, task, `Task ${task}`, ({ keyboard } = {}) => { if (keyboard && from.isConnected) from.focus({ preventScroll: true }); }));
    }
    if (from && from.closest && (from.closest('#inbox-view, #inbox-page, #group-table-view') && document.body.getAttribute('data-nav-tab') === 'hub-inbox')) return go({ view: 'inbox-tasks', sub: 'tasks', id: team, item: task }, { from: title });
    return window.openTeamPage(team, { tab: 'tasks', item: task, from: title }); // from: the title of the goal it is opened from, so its Back says it (#8898)
}
