/* The Team Artifacts panel's search box, filter menu, sort and chips (#4573): its words, fields and sorts on the shared list bar (list_bar.js, #4744). The server does the work: this only
 * collects what to ask for (team_artifact_filters.js). */
import { importOnce } from './import_once.js';
const { EMPTY, KINDS, ORIGINS, SORTS, GROUPS, KIND_LABEL, ORIGIN_LABEL, SORT_LABEL, GROUP_LABEL, clean, chips, isFiltered, without } = await importOnce('./team_artifact_filters.js'); // lazy: its failure is retried
import { buildListBar } from './list_bar.js';

// The same fields for the team's list and for one agent's list (#5283): only the words and the ids differ, so the two bars (one per panel, both in the page) never share an id.
const specFor = (personal, page = false) => {
    const idp = personal ? 'aa' : 'ta';
    return {
        idp,
        noun: 'artifact',
        hideCount: personal,
        label: personal ? 'Search and filter this agent\'s artifacts' : 'Search and filter team artifacts',
        searchLabel: personal ? 'Search this agent\'s artifacts' : 'Search team artifacts',
        placeholder: 'Search artifacts',
        headerSlots: true, // the panel's title and its Refresh and Copy icons sit on the search row (#5315)
        collapsible: true, // the agents tab's pattern (#5293): one icon opens Filters and Sort; the second icon opens or closes every row's details
        expandAll: page ? undefined : { expand: 'Expand all details', collapse: 'Collapse all details' }, // the team page shows details in its pane, not in the rows
        sorts: { values: SORTS, labels: SORT_LABEL, aria: 'Sort artifacts' },
        fields: [
            { type: 'select', key: 'kind', id: `${idp}-kind`, label: 'Type', values: KINDS, labels: KIND_LABEL, any: 'Any type' },
            { type: 'select', key: 'origin', id: `${idp}-origin`, label: 'Origin', values: ORIGINS, labels: ORIGIN_LABEL, any: 'Any origin' },
            { type: 'text', key: 'by', id: `${idp}-by`, className: 'list-bar-by', label: 'Uploaded by', max: 80, placeholder: 'Agent or person', datalist: `${idp}-by-list` },
            // the team's list can be read by task or goal and narrowed to one (#8593): the Task and Goal choices are the ones the page has seen on an artifact (bar.setOptions)
            ...(personal ? [] : [
                { type: 'select', key: 'group', id: `${idp}-group`, label: 'Group by', values: GROUPS, labels: GROUP_LABEL, any: 'No grouping' },
                { type: 'select', key: 'task', id: `${idp}-task`, label: 'Task', values: [], labels: {}, any: 'Any task' },
                { type: 'select', key: 'goal', id: `${idp}-goal`, label: 'Goal', values: [], labels: {}, any: 'Any goal' },
            ]),
            { type: 'check', key: 'kept', id: `${idp}-kept`, label: 'Kept only', wrapClass: 'list-bar-field list-bar-kept' },
            { type: 'date', key: 'from', id: `${idp}-from`, label: 'From' },
            { type: 'date', key: 'to', id: `${idp}-to`, label: 'Until' },
        ],
        model: { EMPTY, clean, chips, isFiltered, without },
    };
};

/** onChange(filters) is called with the new, clean filters when the person changes anything (typing after a short pause). personal: the bar of one agent's Artifacts tab. */
export function buildBar(onChange, { personal = false, page = false, more = null, moreNoun = '', hooks = {} } = {}) {
    return buildListBar({ ...specFor(personal, page), ...(more ? { more, moreNoun } : {}) }, onChange, hooks); // more: the list's other actions behind the More icon (#7686)
}
