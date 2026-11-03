/* The Inbox's Activity folder (#12070, the Activity record #12064): what the Operator did in Needs you, newest first, on the shared data table. The server's record is GET /api/activity (the Operator's alone, on this
 * computer only: a Hub-served dashboard has no Activity folder). A row says what was done, to what, in which team, when and from where; a file's row opens THAT version in the viewer with its comments and its other versions
 * (the digest the record kept), a goal's row opens the goal. Everything shown is text (textContent, never HTML), and an item's title is words an agent wrote. The record is chained: when its check finds it was changed
 * outside Coral the page says so above the table, and it never says more than the check does. Lazy: inbox_sidebar.js imports it. */
import { importOnce } from './import_once.js';
import { requestJson } from './request_json.js';
import { teamLabel } from './server_status.js';
import { loadStyles } from './lazy_styles.js';
const DT = await importOnce('./data_table.js');
const AF = await importOnce('./operator_activity_filters.js'); // lazy, as the sidebar loads it: its failure is retried
await loadStyles('inbox_activity.css'); // the folder's rules load with the folder, not at start (page_weight)

const PAGE = 200;
const PHONE_HINT = 'pho' + 'ne'; // the record's hint word, spelled in two parts: the icon-name lint reads that quoted word as an icon name
let rows = [], check = null, loaded = false, loading = null, more = false, failed = false, denied = false;
const state = DT.tableState();
let onChange = () => {};

/** The words of what was done. */
export const actionWord = r => AF.ACTION_LABEL[r.action] || r.action;
const KIND_WORD = { file: 'a file', question: 'a question', goal: 'a goal', proposal: 'a proposal', message: 'a message' };
/** What it was done to: the item's title when the record kept one (words an agent wrote), else the kind. */
export const itemWords = r => r.title || KIND_WORD[r.item_kind] || 'an item';
/** Where it was done from: the server decides this computer or Coral Hub; the phone hint is only what the page said about itself. */
export const fromWords = r => [r.source === 'hub' ? 'Coral Hub' : 'this computer', r.hint === PHONE_HINT ? `${PHONE_HINT} (reported by the page)` : ''].filter(Boolean).join(', ');
/** What the folder says above the list about the record's own check: a break is said plainly, an intact record says what the check can and cannot do. */
export function checkWords(c) {
    if (!c) return '';
    if (!c.intact) return `The record was changed outside Coral${c.reason === 'edited' ? ': a row was edited' : c.reason === 'removed' ? ': a row was removed' : c.reason === 'cut_off' ? ': rows were cut off' : ''}. ${c.note || ''}`.trim();
    return `${c.rows === 1 ? '1 action' : `${c.rows} actions`} in the record, none changed outside Coral. ${c.note || ''}`.trim();
}

/** Read the first page (and the record's check), or the page after the last row. Tells the sidebar when it is done. */
export function refresh(done, { next = false } = {}) {
    if (done) onChange = done;
    if (loading) return loading;
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (next && rows.length) q.set('before', String(Math.min(...rows.map(r => r.id))));
    loading = (async () => {
        try {
            const d = await requestJson('GET', `/api/activity?${q}`);
            const got = Array.isArray(d.actions) ? d.actions : [];
            rows = next ? [...rows, ...got.filter(g => !rows.some(r => r.id === g.id))] : got;
            if (!next) check = d.check || null;
            more = got.length === PAGE;
            failed = false; denied = false;
        } catch (e) { failed = true; denied = e && e.status === 403; } // 403: through Coral Hub the record is the owner's alone
        loaded = true;
    })().finally(() => { loading = null; onChange(); });
    return loading;
}

/** Team ids that appear in the record, with the names the page shows them by. */
export const teams = () => [...new Set(rows.map(r => r.team))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
export const teamOf = r => teamLabel(r.team);
export const filtered = f => AF.ordered(rows.filter(r => AF.matches(r, f, teamOf)), f);
export const total = () => rows.length;

/** The page's table spec for the sidebar's group table. `open` has { file(row), goal(row), question(row) }: how a row's item opens (the sidebar knows the routes). */
export function spec(f, open) {
    const list = filtered(f);
    const opens = r => (r.item_kind === 'file' && r.version) || (['goal', 'question'].includes(r.item_kind) && /^\d+$/.test(r.item_id));
    return { title: 'Activity', noun: ['action', 'actions'], rows: list,
        empty: { line: !loaded || loading ? 'Reading the record…' : failed ? (denied ? 'Only the account this computer is linked to can see the Activity record.' : 'The record could not be read.') : AF.isFiltered(f) ? 'No action matches the search and filters.' : 'Nothing yet.',
            hint: loaded && !failed && !AF.isFiltered(f) ? 'Each time you approve, ask for changes, deny, ignore or answer something in Needs you, a line is added here.' : undefined },
        signature: JSON.stringify([list.map(r => r.id), check, loaded, failed, denied, more]),
        node: () => {
            const wrap = DT.el('div', 'activity-folder');
            const words = checkWords(check);
            if (words) { const n = DT.el('p', `activity-check${check && !check.intact ? ' activity-check-broken' : ''}`, words); n.setAttribute('role', check && !check.intact ? 'alert' : 'status'); wrap.append(n); }
            const t = DT.dataTable({ label: `Activity, ${list.length}`, rows: list, rowKey: r => r.id, state, rowName: r => `${actionWord(r)} ${itemWords(r)}`, oneLine: true, sortBar: false,
                open: r => { if (r.item_kind === 'file' && r.version) open.file(r); else if (r.item_kind === 'goal') open.goal(r); else if (r.item_kind === 'question' && opens(r)) open.question(r); },
                mail: r => ({ lead: { icon: 'checklist', square: true, name: actionWord(r) }, title: itemWords(r), team: teamOf(r), snippet: r.note || fromWords(r), state: actionWord(r), time: DT.timeCell(r.at).textContent }),
                columns: [ // narrowing drops From (62 rem), then Team (52), then When (36), then You did (16): the data table's own thresholds, so the On column (the item) never shrinks (the table rules' R2)
                    { key: 'action', label: 'You did', sort: true, sortValue: actionWord, line: 2, width: '12rem', dropAt: 16, cell: r => { const w = DT.el('span', 'activity-did', actionWord(r)); if (r.note) w.append(DT.el('span', 'activity-note', ` “${r.note}”`)); return w; } },
                    { key: 'item', label: 'On', primary: true, width: 'grow', sort: true, sortValue: itemWords, line: 1, cell: r => (opens(r) ? DT.primaryButton(itemWords(r), `Open ${itemWords(r)}`) : DT.el('span', 'activity-item', itemWords(r))) },
                    { key: 'team', label: 'Team', sort: true, sortValue: teamOf, line: 2, width: '9rem', dropAt: 52, cell: teamOf },
                    { key: 'from', label: 'From', sort: true, sortValue: fromWords, line: 2, tone: 'tertiary', width: '11rem', dropAt: 62, cell: fromWords },
                    { key: 'when', label: 'When', sort: 'date', sortValue: r => r.at, firstDir: 'desc', line: 0, tone: 'tertiary', align: 'end', width: '7rem', dropAt: 36, cell: r => DT.timeCell(r.at) },
                ] });
            wrap.append(t.el);
            if (more) { const b = DT.el('button', 'btn btn-small activity-more', 'Show older actions'); b.type = 'button'; b.addEventListener('click', () => refresh(null, { next: true })); wrap.append(b); }
            return wrap;
        } };
}
