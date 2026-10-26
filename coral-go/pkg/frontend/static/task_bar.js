/* The Tasks panel's search box, filter menu, sort and chips (#4744): its words, fields and sorts on the shared list bar (list_bar.js). The server does the work: this only collects what
 * to ask for (task_filters.js). */
import { EMPTY, STATUSES, PRIORITIES, SORTS, STATUS_LABEL, PRIORITY_LABEL, SORT_LABEL, clean, chips, isFiltered, without } from './task_filters.js';
import { buildListBar } from './list_bar.js';

const SPEC = {
    idp: 'tk',
    noun: 'task',
    hideCount: true,
    label: 'Search and filter tasks',
    searchLabel: 'Search tasks',
    placeholder: 'Search tasks',
    collapsible: true, // the agents tab's pattern (#5293): one icon opens Filters and Sort
    sorts: { values: SORTS, labels: SORT_LABEL, aria: 'Sort tasks' },
    fields: [
        { type: 'select', key: 'status', id: 'tk-status', label: 'Status', values: STATUSES, labels: STATUS_LABEL, any: 'Any status' },
        { type: 'select', key: 'priority', id: 'tk-priority', label: 'Priority', values: PRIORITIES, labels: PRIORITY_LABEL, any: 'Any priority' },
        { type: 'text', key: 'assignee', id: 'tk-assignee', className: 'list-bar-by', label: 'Agent', max: 80, placeholder: 'Agent name', datalist: 'tk-assignee-list' },
        { type: 'date', key: 'from', id: 'tk-from', label: 'Updated since' },
    ],
    model: { EMPTY, clean, chips, isFiltered, without },
};

// The team page's Tasks tab (#7782): no Status field (the state pills above the list are the status), the goal as a select (the page fills its options: No goal, then the team's goals with their task counts), the agent
// as a select of the team's members, and the fields two to a line. The board's own Tasks panel (task_list.js) keeps the full set.
const TEAM_SPEC = {
    ...SPEC,
    compactPanel: true,
    chipsElsewhere: true, // the page puts every filter that is on as a chip on its toolbar line
    fields: [
        SPEC.fields[1],
        { type: 'select', key: 'goal', id: 'tk-goal', label: 'Goal', values: [], labels: {}, any: 'Any goal' },
        { type: 'select', key: 'assignee', id: 'tk-assignee', label: 'Agent', values: [], labels: {}, any: 'Any agent' },
        SPEC.fields[3],
    ],
};

/** onChange(filters) is called with the new, clean filters when the person changes anything (typing after a short pause). team: the team page's Tasks tab's panel. */
// The dock's Tasks panel (#7924): the one top row (the search, the Filters icon, + Task), so the bar has a slot for the owner's button after the icon; Hide done is the owner's extra in the panel.
const DOCK_SPEC = { ...SPEC, headerSlots: true };

export function buildTaskBar(onChange, hooks = {}, { team = false, dock = false } = {}) {
    return buildListBar(team ? TEAM_SPEC : dock ? DOCK_SPEC : SPEC, onChange, hooks);
}
