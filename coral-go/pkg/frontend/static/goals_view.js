/* The local Goals view (#7113, UI/UX's #7091 design, layout A): the second face of a board's screen, beside Messages. A list on the left (filter chips, Waiting on you, one card per goal), the open goal
 * on the right (outcome, done when, the rollup, its tasks with Open task and Open the agent); on a phone the two are two screens with a back row. First cut: read, plus New goal.
 * The routes' JSON becomes the model in goals_adapter.js, the words come from goal_words.js; everything drawn here is built with the DOM and textContent (no text from a goal or a task is read as markup).
 * Lazy: message_board.js imports it when the Goals face is chosen. */
import { state } from './state.js';
import { boardFetch, keyLabel, splitKey, LOCAL_SERVER } from './server_base.js';
import { OPERATOR_ID, showToast } from './utils.js';
import { onGoalsSeq } from './goals_feed.js';
import { pollEvery } from './overload.js';
import { toGoalList, mergeGoalLists, toDrivers, createBody, errorOf, LIST_PATH } from './goals_adapter.js';
import { importOnce } from './import_once.js';
const Toolbar = await importOnce('./team_toolbar.js'); // the one toolbar of the team tabs (#7717)
const DT = await importOnce('./data_table.js'); // the one table (#7743): the goal's column is its folded form
const GC = await importOnce('./goal_columns.js');

import * as W from './goal_words.js';
const { mountGoal } = await importOnce('./goal_view.js');
let detail = null, detailHost = null, detailId = 0;
function clearDetail() { detail?.dispose(); detail = null; detailHost = null; detailId = 0; }

const DEFAULT_FILTER = 'active'; // the Goals tab opens on the goals in progress, not on every goal ever (#8517, the operator); a pill the person picks is kept while they are on the team
const model = { project: '', sig: '', goals: [], requireGoal: false, noGoalOpen: null, filter: DEFAULT_FILTER, openId: 0, loading: false, failed: '', asOf: '', creating: false, goalSearch: '' };
const PHONE = matchMedia('(max-width: 760px)'); // the team page's phone layout (team_page.css): a goal, its task list and a task are three screens
let root = null;
let layout = 'cards'; // 'cards': the board's Goals face (cards and the goal beside them); 'page': the team page's Goals tab (a table, and a goal's own page, #7453)
let hooks = {}; // the page's: openTask(task, goal), onCount(n)

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const say = (t) => { const s = root && root.querySelector('.goals-status'); if (s) { s.textContent = ''; s.textContent = t; } }; // a status region: written once, announced once

/** An Error carrying the route's code and sentence (or the status when the answer is not JSON). */
async function failure(r) {
    let e = { code: '', message: '' };
    try { e = errorOf(await r.json()); } catch { /* the status stays */ }
    return Object.assign(new Error(e.message || `${r.status}`), { code: e.code });
}

async function readJson(path) {
    const r = await boardFetch(model.project, path);
    if (!r.ok) throw await failure(r);
    return r.json();
}

/** Read the board's goals. A failed read keeps the last list on screen, marked "as of <time>". */
export async function loadGoals() {
    if (!model.project) return;
    const project = model.project;
    model.loading = !model.goals.length;
    if (model.loading) draw(); // "Loading goals…" only while there is nothing yet: a refresh does not redraw before it has an answer
    let same = false, focusOpened = false;
    try {
        const settingsRead = readJson('/settings').then(s => Boolean(s && s.require_goal), () => false); // the list does not say whether the board requires a goal: its settings do (#7253)
        let list = toGoalList(await readJson(LIST_PATH));
        for (let n = 0; list.cursor && n < 40; n++) { // the route pages (200 at most): read on until there is no cursor (#7239)
            list = mergeGoalLists(list, toGoalList(await readJson(`${LIST_PATH}&cursor=${encodeURIComponent(list.cursor)}`)));
        }
        list.requireGoal = list.requireGoal || await settingsRead;
        if (project !== model.project) return;
        const sig = JSON.stringify([list.goals, list.requireGoal, list.noGoalOpen]);
        same = !model.failed && !!model.goals.length && sig === model.sig; // nothing changed: the page is left as it is (a redraw would take the keyboard's place)
        if (layout === 'page') hooks.onCount?.(list.goals.length, list.goals.filter(x => W.isOpenGoal(x)).length);
        model.sig = sig; model.goals = list.goals; model.requireGoal = list.requireGoal; model.noGoalOpen = list.noGoalOpen; model.failed = ''; model.asOf = clock();
        if (model.wantOpen) { const want = model.wantOpen; model.wantOpen = 0; if (model.goals.some(g => g.id === want)) { model.openId = want; same = false; focusOpened = true; } }
        if (model.openId && !model.goals.some(g => g.id === model.openId)) { model.openId = 0; same = false; }
    } catch (e) {
        if (project !== model.project) return;
        model.failed = W.failedText(e && e.message); model.sig = '';
    }
    model.loading = false;
    if (!same) draw();
    if (focusOpened) focusDetail();
    if (model.openId) detail?.refreshTasks();
}

const goalById = (id) => model.goals.find(g => g.id === id);
const visible = () => model.goals.filter(g => W.keepsGoal(model.filter, g) && (!model.goalSearch.trim() || String(g.title || '').toLowerCase().includes(model.goalSearch.trim().toLowerCase())));

// ── drawing ──────────────────────────────────────────────────────────────

/** Focus goes to the detail as a whole when a goal opens (its name is read: the goal's title), not to a heading that cannot be typed in: no ring is drawn round words (#7404). */
function focusDetail() { root?.querySelector(layout === 'page' ? '.goal-main .goals-back, #goals-detail-title' : '.goals-detail-col')?.focus({ preventScroll: true }); } // a goal's page starts the keyboard at its way back, not its heading: no ring round plain words (#7404)

/** Redraw a column and give the keyboard its place back: the control that had focus (a chip by its filter, a card by its goal, anything else by its class and words) is found again in the new draw; when it is gone ("Show all" and "Try again" go when they work) focus goes to the pressed chip, never to the page. */
function keepFocus(col, redraw) {
    const a = document.activeElement;
    const held = a && col && col.contains(a) && a !== col ? { sortKey: a.classList.contains('dt-sort') ? a.dataset.key : '', sortSelect: a.classList.contains('dt-sortbar-select'), sortDir: a.classList.contains('dt-sortbar-dir'), filter: a.dataset.filter, goal: a.dataset.goalId, id: a.id, cls: a.className, text: a.textContent } : null;
    redraw();
    if (!held) return;
    const all = [...col.querySelectorAll('button, [tabindex]')];
    const same = held.sortKey ? col.querySelector(`.dt-sort[data-key="${CSS.escape(held.sortKey)}"]`) : held.sortSelect ? col.querySelector('.dt-sortbar-select') : held.sortDir ? col.querySelector('.dt-sortbar-dir') : held.filter ? col.querySelector(`.goals-chip[data-filter="${CSS.escape(held.filter)}"]`) : held.goal ? col.querySelector(`[data-goal-id="${CSS.escape(held.goal)}"]`) : held.id ? col.querySelector(`#${CSS.escape(held.id)}`) : all.find(e => e.className === held.cls && e.textContent === held.text);
    (same || col.querySelector('.goals-chip[aria-pressed="true"]') || (col.classList.contains('goals-detail-col') ? col : col.querySelector('#goals-detail-title')))?.focus({ preventScroll: true }); // gone because it worked: the pressed chip in the list, the goal's heading in the detail
}

const drawList = () => drawPage(); // the chips are above the list column: the keyboard is looked for in both

// ── the team page's Goals tab (#7453): a table of the goals; a goal's own page with its tasks as a table ────────────────

const doneOf = (rollup) => rollup.done, totalOf = (rollup) => W.allTasksOf(rollup);
let goalsTableState = DT.tableState();

function drawPage() {
    const body = root && root.querySelector('.goals-body'); if (!body) return;
    if (!model.openId || !goalById(model.openId)) clearDetail();
    keepFocus(body, () => (model.openId && goalById(model.openId) ? drawGoalPageRaw(body) : drawTableRaw(body)));
    root.classList.toggle('goals-open', !!model.openId && !!goalById(model.openId));
}

function goalBulkActions() {
    return [{ label: 'Close goals', danger: true,
        choose: { label: 'Close as', options: () => [{ value: 'done', label: 'Done' }, { value: 'dropped', label: 'Dropped' }], text: { label: 'Reason for closing', maxLength: 300 } },
        confirm: n => `Close ${n} goals? Any open tasks stay open.`, run: async (rows, keys, as, reason) => {
            if (model.bulkBusy || !reason) return; model.bulkBusy = true;
            const project = model.project, tableState = goalsTableState; let done = 0, failed = 0;
            for (const g of rows) { try {
                const r = await boardFetch(project, `/goals/${g.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, state: as, reason }) });
                if (!r.ok) throw new Error('Close failed'); tableState.selected.delete(String(g.id)); done++;
            } catch { failed++; } }
            model.bulkBusy = false; showToast(`Closed ${done} goals${failed ? `; ${failed} failed and remain selected` : ''}`, !!failed);
            if (project === model.project) { await loadGoals(); root?.querySelector('#goals-search')?.focus({ preventScroll: true }); }
        } }];
}

function drawTableRaw(col) {
    col.replaceChildren();
    const counts = W.filterCounts(model.goals);
    // The one toolbar line (#7717): the search field, the state pills (one compact select when they do not fit) and New goal at the right.
    const toolbar = Toolbar.build({
        id: 'goals-search', label: 'Search goals', placeholder: 'Search goals', value: model.goalSearch,
        onSearch: text => { model.goalSearch = text; drawList(); },
        pills: { label: 'Show goals that are', current: model.filter, items: W.FILTERS.map(f => ({ key: f, label: W.filterLabel(f), count: counts[f] })), onPick: f => { model.filter = f; say(W.filterAnnouncement(f, counts[f])); drawList(); } },
        action: btn('btn btn-primary goals-new', 'New goal', () => openCreate()),
    });
    col.append(toolbar);
    if (model.requireGoal) col.append(Object.assign(el('p', 'goals-note goals-require'), { textContent: W.requireGoalNote }));
    if (state.hubConnected || window.__goalsHub) col.append(el('p', 'goals-note', W.otherBoardsNote));
    if (model.failed) {
        const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert');
        f.append(el('span', null, `${model.failed}${model.goals.length ? ` (${W.asOfText(model.asOf)})` : ''}`), btn('btn btn-small', 'Try again', loadGoals));
        col.append(f);
    }
    if (model.loading) { col.append(el('p', 'goals-note', 'Loading goals…')); return; }
    if (!model.goals.length) { if (!model.failed) { const e = el('div', 'empty-state empty-state-tight'); e.append(el('p', 'empty-state-line', W.noGoalsText)); col.append(e); } return; }
    const shown = visible();
    if (!shown.length && !goalsTableState.selected.size) {
        const fe = W.filteredEmpty(model.filter, model.goals.length);
        const e = el('div', 'empty-state empty-state-tight'); e.append(el('p', 'empty-state-line', fe.text), btn('btn empty-state-action', fe.action, () => { model.filter = 'all'; say(W.filterAnnouncement('all', model.goals.length)); drawList(); }));
        col.append(e);
        return;
    }
    const sort = goalsTableState.sort;
    const sortValue = g => sort.key === 'goal' ? g.title : sort.key === 'state' ? W.stateWord(g) : sort.key === 'progress' ? (totalOf(g.rollup) ? doneOf(g.rollup) / totalOf(g.rollup) : 0) : g.updatedAt;
    if (sort) shown.sort((a, b) => { const x = sortValue(a), y = sortValue(b); return (sort.dir === 'desc' ? -1 : 1) * (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })); });
    const rows = shown.concat(model.noGoalOpen > 0 && (model.filter === 'all' || model.filter === DEFAULT_FILTER) ? [{ id: 'no-goal', title: W.noGoalRowText(model.noGoalOpen), noGoal: true }] : []);
    const table = DT.dataTable({
        label: `Goals, ${shown.length}`, rows, rowKey: g => g.id, state: goalsTableState, rowName: g => g.title,
        selectable: { contextKey: model.project, canSelect: g => !g.noGoal && W.isOpenGoal(g), actions: goalBulkActions(), onChange: keys => Toolbar.mountSelection(toolbar, keys.size ? table.bar : null) },
        onSort: () => drawList(), // keep the no-goal navigation row last in either direction
        open: g => g.noGoal ? window.openTeamPage?.(model.project, { tab: 'tasks', noGoal: true }) : openGoal(g.id, true),
        columns: GC.goalColumns({ progressLabel: 'Tasks' }, ['goal', 'state', 'progress', 'updated']),
    });
    col.append(table.el); Toolbar.mountSelection(toolbar, goalsTableState.selected.size ? table.bar : null);
    if (PHONE.matches) toolbar.querySelector('.goals-new')?.before(table.selectButton);
}

function drawGoalPageRaw(col) {
    const goal = goalById(model.openId);
    if (detail && detailHost === col && detailId === goal.id) { detail.update(goal); return; }
    clearDetail();
    detailHost = col; detailId = goal.id;
    detail = mountGoal(col, { team: model.project, id: goal.id, goal, back: closeGoal, refresh: loadGoals, status: say });
}

function draw() {
    if (!root) return;
    drawPage();
}

/** Open a goal (focus moves to its heading when asked: a person chose it) and read its tasks. */
/** Open a goal that may not be read yet (the Goal line of a task): now when the list has it, else when the next read does (#7253). */
export function openGoalWhenKnown(id) {
    if (model.goals.some(g => g.id === id)) { openGoal(id, true); return; }
    model.wantOpen = id;
    loadGoals();
}

export function openGoal(id, focus = false) {
    model.openId = id;
    if (layout === 'page') hooks.onItem?.(id);
    draw();
    if (focus) focusDetail();
    detail?.refreshTasks();
}

export function closeGoal() {
    const id = model.openId;
    model.openId = 0;
    if (layout === 'page') hooks.onItem?.(0);
    draw();
    (root.querySelector(`.goal-card[data-goal-id="${id}"]`) || root.querySelector(`.dt-primary[data-goal-id="${id}"]`))?.focus();
}

/** The goal page's own id (0 on the list): the team page asks it to put the address and the Back button right. */
export const openGoalId = () => model.openId;

// ── New goal ─────────────────────────────────────────────────────────────

function openCreate() {
    if (model.creating) return;
    model.creating = true;
    const dlg = document.createElement('dialog'); dlg.className = 'dlg-confirm goals-dialog'; dlg.setAttribute('aria-labelledby', 'goals-create-title');
    const form = el('form', 'goals-form'); form.noValidate = true;
    const title = el('h3', null, 'New goal'); title.id = 'goals-create-title';
    const field = (label, input, id) => { const l = el('label', 'goals-field'); l.append(el('span', null, label), input); input.id = id; return l; };
    const t = el('input'); t.type = 'text'; t.maxLength = 200; t.autocomplete = 'off';
    const d = el('input'); d.type = 'text'; d.maxLength = 300; d.autocomplete = 'off';
    const dr = el('select'); dr.disabled = true; dr.append(new Option('Loading this board\'s agents…', '')); // the board's own agents: the route refuses a name that is not a subscriber
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert');
    const driverNote = el('p', 'goals-note', W.driverHelp); driverNote.id = 'goal-new-driver-help'; dr.setAttribute('aria-describedby', driverNote.id); // what a driver is
    const where = el('p', 'goals-note', `Created on this board: ${keyLabel(model.project)}`);
    const go = btn('btn btn-primary', 'Create goal'); go.type = 'submit';
    const cancel = btn('btn', 'Cancel', () => dlg.close());
    form.append(title, field('Title (required)', t, 'goal-new-title'), field('Done when (optional): what a person can check', d, 'goal-new-done'), field('Driver (optional)', dr, 'goal-new-driver'), driverNote, where, err, el('div', 'goals-actions'));
    form.querySelector('.goals-actions').append(cancel, go);
    dlg.append(form); document.body.append(dlg);
    readJson('/subscribers').then(json => {
        const people = toDrivers(json);
        dr.replaceChildren(...people.map(p => new Option(p.label, p.id)), new Option('No driver yet', ''));
        dr.value = people.length && people[0].orchestrator ? people[0].id : ''; // the Orchestrator drives unless the person says otherwise
        dr.disabled = false;
    }).catch(() => { dr.replaceChildren(new Option('No driver yet', '')); dr.disabled = false; where.textContent += '. This board\'s agents could not be read, so no driver is set.'; });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!t.value.trim()) { err.textContent = 'A goal needs a title.'; t.setAttribute('aria-invalid', 'true'); t.focus(); return; }
        t.removeAttribute('aria-invalid'); go.disabled = true;
        try {
            const r = await boardFetch(model.project, '/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createBody({ title: t.value, doneWhen: d.value, driver: dr.value, by: OPERATOR_ID })) });
            if (!r.ok) throw await failure(r);
            dlg.close();
            say('Goal created');
            await loadGoals();
            root.querySelector('.goals-new')?.focus(); // the list was drawn again: focus goes back to the button that opened the dialog
        } catch (ex) { err.textContent = `The goal was not created: ${W.errorWords(ex && ex.code, ex && ex.message)}`; go.disabled = false; }
    });
    dlg.addEventListener('close', () => { model.creating = false; dlg.remove(); root.querySelector('.goals-new')?.focus(); });
    dlg.showModal(); t.focus();
}

// ── showing and hiding ───────────────────────────────────────────────────

/** Show the board's goals in `host` (the page's #mb-goals) and read them. */
export function showGoals(host, project, opts = {}) {
    if (project !== model.project) { clearDetail(); goalsTableState = DT.tableState(); Object.assign(model, { project, sig: '', goals: [], requireGoal: false, noGoalOpen: null, filter: DEFAULT_FILTER, openId: 0, failed: '', asOf: '', loading: false }); }
    layout = 'page';
    hooks = opts.hooks || {};
    if (host.dataset.built !== 'page') { // the team page's Goals tab (#7453): the status line for a screen reader, and one body that is the table or a goal's page
        host.dataset.built = 'page';
        const page = el('div', 'goals-page goals-table-page');
        const status = el('div', 'goals-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        page.append(status, el('div', 'goals-body'));
        host.replaceChildren(page);
    }
    root = host.querySelector('.goals-page');
    host.hidden = false;
    draw();
    loadGoals();
    watchGoals(host);
}

// The view keeps itself current (#7223): when this board's change counter moves in the /ws/coral frames, and when the window comes back to the front; the open goal and how many of its tasks were shown stay.
let _stop = null, _bound = false, _reading = false, _again = false;
const bareBoard = () => { const k = splitKey(model.project); return k.server === LOCAL_SERVER ? k.name : ''; };
function refresh() {
    if (!root || !root.isConnected || root.closest('[hidden]') || !model.project) return;
    if (_reading) { _again = true; return; } // one read at a time; a change that came meanwhile is read next
    _reading = true;
    loadGoals().finally(() => { _reading = false; if (_again) { _again = false; refresh(); } });
}
function watchGoals() {
    if (_stop) _stop();
    _stop = onGoalsSeq((board) => { if (board === bareBoard()) refresh(); });
    if (_bound) return;
    _bound = true;
    pollEvery(() => { if (root && root.isConnected && !root.closest('[hidden]')) draw(); }, 60000); // "just now" and the times on the cards move on by the minute, without a read
    pollEvery(refresh, 30000); // a slow safety read: a claim or a review of a linked task does not move the board's seq (QA's #7236), and a read that finds the same draws nothing
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
