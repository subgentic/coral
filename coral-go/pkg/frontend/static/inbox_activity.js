/* The Inbox's Activity folder (#12070, the Activity record #12064): what the Operator did in Needs you, newest first, on the shared data table. The server's record is GET /api/activity (the Operator's alone, on this
 * computer; a dashboard that links other computers reads each online one on its own and merges them, #15380). A row says what was done, to what, in which team, when and from where; a file's row opens THAT version in the viewer with its comments and its other versions
 * (the digest the record kept), a goal's row opens the goal. Everything shown is text (textContent, never HTML), and an item's title is words an agent wrote. The record is chained: when its check finds it was changed
 * outside Coral the page says so above the table, and it never says more than the check does. Lazy: inbox_sidebar.js imports it. */
import { importOnce } from './import_once.js';
import { requestJson } from './request_json.js';
import { teamLabel } from './server_status.js';
import { serverFetch, identityKey, LOCAL_SERVER } from './server_base.js';
import { inboxSources, multipleServers, serverLabel, serverColumns } from './inbox_servers.js';
const { activityParts, aboutWords, jobRunParts } = await importOnce('./operator_activity_words.js');
import { markHidden } from './visible_marks.js';
import { loadStyles } from './lazy_styles.js';
const DT = await importOnce('./data_table.js');
const Threads = await importOnce('./activity_threads.js');
const AF = await importOnce('./operator_activity_filters.js'); // lazy, as the sidebar loads it: its failure is retried
await loadStyles('inbox_activity.css'); // the folder's rules load with the folder, not at start (page_weight)

const PAGE = 200;
const PHONE_HINT = 'pho' + 'ne'; // the record's hint word, spelled in two parts: the icon-name lint reads that quoted word as an icon name
let rows = [], check = null, loaded = false, loading = null, more = false, failed = false, denied = false;
/** Each computer owns its cursor and its own check (#15380): a cursor is never sent to another computer. `moreBy` says which computers have older actions; `unread` names the ones that could not be read this time. */
let cursors = {}, moreBy = {}, checks = {}, unread = [];
/** A row's own key: ids are only unique on their computer. */
export const keyOf = r => r.server && r.server !== LOCAL_SERVER ? `${r.server}/${r.id}` : String(r.id);
const state = DT.tableState();
let onChange = () => {};

/** The row as the one rule says it (#14423): verb, object, detail. */
export const partsOf = r => ({ ...activityParts(r, itemWords), about: aboutWords(r) });
const KIND_WORD = { file: 'a file', question: 'a question', goal: 'a goal', proposal: 'a proposal', message: 'a message', task: 'a task', agent: 'an agent', chat: 'a chat', run: 'a run', workflow_run: 'a workflow run', job_run: 'an automation run', setting: 'a row in Needs you', goal_request: 'a goal request' };
/** What it was done to: the item's title when the record kept one (words an agent wrote), else the kind. */
export const itemWords = r => r.item_kind === 'job_run' ? (r.title && r.title !== '__oneshot__' ? r.title : jobRunParts(r.item_id) ? `Job ${jobRunParts(r.item_id).jobId}` : 'an automation run') : r.title || (r.item_kind === 'agent' && r.item_id ? r.item_id : r.item_kind === 'task' && r.item_id ? `Task #${r.item_id}` : KIND_WORD[r.item_kind]) || 'an item';
/** Where it was done from: the server decides this computer or Coral Hub; the phone hint is only what the page said about itself. */
export const fromWords = r => [r.source === 'hub' ? 'Coral Hub' : 'this computer', r.hint === PHONE_HINT ? `${PHONE_HINT} (reported by the page)` : ''].filter(Boolean).join(', ');
/** What the folder says above the list about the record's own check: a break is said plainly, an intact record says what the check can and cannot do. */
export function checkWords(c) {
    if (!c) return '';
    if (!c.intact) return `${c.machine ? `On ${c.machine}: t` : 'T'}he record was changed outside Coral${c.reason === 'edited' ? ': a row was edited' : c.reason === 'removed' ? ': a row was removed' : c.reason === 'cut_off' ? ': rows were cut off' : ''}. ${c.note || ''}`.trim();
    return `${c.rows === 1 ? '1 action' : `${c.rows} actions`} in the record, none changed outside Coral. ${c.note || ''}`.trim();
}

/** What the folder reads from: the online computers on a Hub-served dashboard (several, or one that is not this one), else this computer alone, which is read exactly as it always was. */
const sourcesNow = () => { const s = inboxSources(); return s.length > 1 || (s.length === 1 && s[0] !== LOCAL_SERVER) ? s : null; };

/** The record's checks as the one the page says: a broken one names its computer (when there are several), else the intact ones are summed. */
function combineChecks(map) {
    const all = Object.entries(map).filter(([, c]) => c);
    if (!all.length) return null;
    const several = all.length > 1;
    const broken = all.find(([, c]) => !c.intact);
    if (broken) return several ? { ...broken[1], machine: serverLabel(broken[0]) } : broken[1];
    return several ? { intact: true, rows: all.reduce((n, [, c]) => n + (Number(c.rows) || 0), 0), note: all[0][1].note } : all[0][1];
}

const atOf = r => { const t = Date.parse(r.at); return Number.isFinite(t) ? t : -Infinity; };

/** Read the first page (and the record's check), or the page after the last row. Tells the sidebar when it is done. On a Hub with linked computers every online one is read on its own (one failing does not fail the folder),
 *  each action carries its computer, and the folder is the actions of all of them, newest first. */
export function refresh(done, { next = false } = {}) {
    if (done) onChange = done;
    if (loading) return loading;
    const sources = sourcesNow();
    if (!sources) { // this computer alone
        const q = new URLSearchParams({ limit: String(PAGE) });
        if (next && rows.length) q.set('before', String(Math.min(...rows.map(r => r.id))));
        loading = (async () => {
            try {
                const d = await requestJson('GET', `/api/activity?${q}`);
                const got = Array.isArray(d.actions) ? d.actions : [];
                rows = next ? [...rows, ...got.filter(g => !rows.some(r => r.id === g.id))] : got;
                if (!next) check = d.check || null;
                more = got.length === PAGE;
                unread = [];
                failed = false; denied = false;
            } catch (e) { failed = true; denied = e && e.status === 403; } // 403: through Coral Hub the record is the owner's alone
            loaded = true;
        })().finally(() => { loading = null; onChange(); });
        return loading;
    }
    const targets = next ? sources.filter(id => moreBy[id]) : sources;
    loading = (async () => {
        const settled = await Promise.allSettled(targets.map(async server => {
            const q = new URLSearchParams({ limit: String(PAGE) });
            if (next && cursors[server] != null) q.set('before', String(cursors[server]));
            const r = await serverFetch(server === LOCAL_SERVER ? undefined : server, `/api/activity?${q}`);
            if (r.status === 403) return { server, denied: true };
            if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { server });
            const d = await r.json();
            const got = (Array.isArray(d.actions) ? d.actions : []).filter(a => a && Number.isSafeInteger(a.id)).map(a => ({ ...a, server, team: identityKey(server, a.team) }));
            return { server, got, check: d.check || null, more: got.length === PAGE };
        }));
        const answered = settled.filter(x => x.status === 'fulfilled' && !x.value.denied).map(x => x.value);
        const deniedAll = settled.length > 0 && settled.every(x => x.status === 'fulfilled' && x.value.denied);
        if (!next) { rows = []; cursors = {}; moreBy = {}; checks = {}; }
        const seen = new Set(rows.map(keyOf));
        for (const a of answered) {
            for (const row of a.got) if (!seen.has(keyOf(row))) { seen.add(keyOf(row)); rows.push(row); }
            moreBy[a.server] = a.more;
            if (a.got.length) cursors[a.server] = Math.min(...rows.filter(r => r.server === a.server).map(r => r.id));
            if (!next) checks[a.server] = a.check;
        }
        rows.sort((x, y) => atOf(y) - atOf(x));
        check = combineChecks(checks);
        more = Object.values(moreBy).some(Boolean);
        unread = settled.map((x, i) => x.status === 'rejected' ? targets[i] : null).filter(Boolean);
        failed = answered.length === 0 && !deniedAll && settled.some(x => x.status === 'rejected');
        denied = deniedAll;
        loaded = true;
    })().finally(() => { loading = null; onChange(); });
    return loading;
}

/** Forget what was read from computers (sign-out, a computer removed): nothing is kept past that, and none of it is ever written to storage. */
export function forget() { rows = []; check = null; loaded = false; more = false; failed = false; denied = false; cursors = {}; moreBy = {}; checks = {}; unread = []; }

/** Team ids that appear in the record, with the names the page shows them by. */
export const teams = () => [...new Set(rows.map(r => r.team))].sort((a, b) => teamLabel(a).localeCompare(teamLabel(b)));
/** The agents and the goals the record names, for the Filters panel's lists (#14445): the agents by name, the goals by title with No goal last when any row has none. */
export const agents = () => [...new Set(rows.map(AF.agentOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
export const goals = () => { const all = [...new Set(rows.map(AF.goalOf))]; return [...all.filter(g => g !== AF.NO_GOAL).sort((a, b) => a.localeCompare(b)), ...all.filter(g => g === AF.NO_GOAL)]; };
export const teamOf = r => teamLabel(r.team);
export const filtered = f => AF.ordered(rows.filter(r => AF.matches(r, f, teamOf)), f);
export const total = () => rows.length;

/** The page's table spec for the sidebar's group table. `open` has { file(row), goal(row), question(row) }: how a row's item opens (the sidebar knows the routes). */
export function spec(f, open, { grouped = false, byTask = true, tasks, taskSignature = '' } = {}) {
    const list = filtered(f);
    const parts = r => { const p = partsOf(r); return grouped && byTask && r.goal_id && r.task_id ? { ...p, about: '' } : p; };
    const decision = r => { const label = AF.DECISION_LABEL[AF.decisionOf(r)]; if (!label) return DT.el('span', 'activity-did', parts(r).did); const chip = DT.tag(parts(r).did); chip.classList.add('activity-decision'); return chip; };
    const summary = r => { const p = parts(r); return [p.did, p.detail, p.about ? markHidden(p.about, { strict: true }) : ''].filter(Boolean).join(' · '); };
    const groupFor = grouped ? Threads.activityGroupLookup(list, teamLabel, parts, tasks, byTask) : null;
    const opens = r => (r.item_kind === 'job_run' && !!jobRunParts(r.item_id)) || (r.item_kind === 'file' && /^[a-f0-9]{64}$/i.test(r.version || r.item_id || '')) || (r.item_kind === 'agent' && r.item_id && r.action !== 'agents_record') || (['goal', 'question', 'task', 'message', 'workflow_run'].includes(r.item_kind) && /^\d+$/.test(r.item_id)) || (r.item_kind === 'chat' && !!r.item_id);
    return { title: 'Activity', noun: ['action', 'actions'], rows: list,
        empty: { line: !loaded || loading ? 'Reading the record…' : failed ? (denied ? 'Only the account this computer is linked to can see the Activity record.' : 'The record could not be read.') : AF.isFiltered(f) ? 'No action matches the search and filters.' : 'Nothing yet.',
            hint: loaded && !failed && !AF.isFiltered(f) ? 'Each time you approve, ask for changes, deny, ignore or answer something in Needs you, a line is added here.' : undefined },
        signature: JSON.stringify([list.map(keyOf), check, loaded, failed, denied, more, unread, multipleServers(), grouped, grouped ? taskSignature : '']),
        node: () => {
            const wrap = DT.el('div', 'activity-folder');
            const words = checkWords(check);
            if (words) { const n = DT.el('p', `activity-check${check && !check.intact ? ' activity-check-broken' : ''}`, words); n.setAttribute('role', check && !check.intact ? 'alert' : 'status'); wrap.append(n); }
            const t = DT.dataTable({ label: `Activity, ${list.length}`, rows: list, ...(grouped ? { orderRows: Threads.arrangeActivityRows, groupSorted: true, groupBy: groupFor } : {}), rowKey: keyOf, state, decorate: (r, tr) => { const ask = tr.querySelector('.dt-mail-ask'); if (ask) { const p = parts(r); ask.replaceChildren(decision(r)); if (p.detail) ask.append(' · ', p.detail); if (p.about) ask.append(' · ', markHidden(p.about, { strict: true })); } if (opens(r)) return; const button = tr.querySelector('button.dt-mail-open'); if (button) { const text = DT.el('span', button.className.replace('dt-primary', '')); text.append(...button.childNodes); button.replaceWith(text); } }, wrapMail: true, rowName: r => { const p = parts(r); return `${p.on} ${summary(r)}`; }, oneLine: true, resize: true, sortBar: false,
                open: r => { if (!opens(r)) return; if (r.item_kind === 'file' && /^[a-f0-9]{64}$/i.test(r.version || r.item_id || '')) open.file(r); else if (r.item_kind === 'goal') open.goal(r); else if (r.item_kind === 'question' && opens(r)) open.question(r); else if (r.item_kind === 'task' && opens(r)) open.task(r); else if (r.item_kind === 'agent' && opens(r)) open.agent(r); else if (r.item_kind === 'message' && opens(r)) open.message(r); else if (r.item_kind === 'chat' && opens(r)) open.chat(r); else if (r.item_kind === 'workflow_run' && opens(r)) open.workflow(r); else if (r.item_kind === 'job_run' && opens(r)) open.job(r, jobRunParts(r.item_id)); },
                mail: r => { const p = parts(r); return { lead: { icon: 'checklist', square: true, name: p.did }, title: p.on, team: teamOf(r), snippet: '', ask: summary(r), time: DT.timeCell(r.at).textContent }; },
                columns: [ // narrowing drops From (62 rem), then Team (52), then When (36), then You did (16): the data table's own thresholds, so the On column (the item) never shrinks (the table rules' R2)
                    { key: 'action', label: 'You did', sort: true, sortValue: r => parts(r).did, line: 2, width: '12rem', dropAt: 16, cell: decision },
                    { key: 'item', label: 'On', primary: true, width: 'grow', sort: true, sortValue: r => parts(r).on, line: 1, cell: r => { const p = parts(r), el = opens(r) ? DT.primaryButton(p.on, `${p.on}. ${p.about ? `${markHidden(p.about, { strict: true })}. ` : ''}Open ${itemWords(r)}`) : DT.el('span', 'activity-item', p.on); DT.tipIf(el, p.on, () => el.scrollWidth > el.clientWidth); if (!p.detail && !p.about) return el; const cell = DT.el('span', 'activity-on'); cell.append(el); if (p.detail) cell.append(DT.el('span', 'activity-detail', p.detail)); if (p.about) cell.append(DT.el('span', 'activity-about', markHidden(p.about, { strict: true }))); return cell; } }, // the detail is its own line under the object, whole (never cut)
                    ...serverColumns(),
                    { key: 'team', label: 'Team', sort: true, sortValue: teamOf, line: 2, width: '9rem', dropAt: 52, cell: teamOf },
                    { key: 'from', label: 'From', sort: true, sortValue: fromWords, line: 2, tone: 'tertiary', width: '11rem', dropAt: 62, cell: fromWords },
                    { key: 'when', label: 'When', sort: 'date', sortValue: r => r.at, firstDir: 'desc', line: 0, tone: 'tertiary', align: 'end', width: '7rem', dropAt: 36, cell: r => DT.timeCell(r.at) },
                ] });
            wrap.append(t.el);
            if (unread.length) { const n = DT.el('p', 'activity-check', `The record could not be read from ${unread.map(serverLabel).join(', ')}.`); n.setAttribute('role', 'status'); wrap.prepend(n); }
            if (more) { const b = DT.el('button', 'btn btn-small activity-more', 'Show older actions'); b.type = 'button'; b.addEventListener('click', () => refresh(null, { next: true })); wrap.append(b); }
            return wrap;
        } };
}
