/* The local Goals view (#7113, UI/UX's #7091 design, layout A): the second face of a board's screen, beside Messages. A list on the left (filter chips, Waiting on you, one card per goal), the open goal
 * on the right (outcome, done when, the rollup, its tasks with Open task and Open the agent); on a phone the two are two screens with a back row. First cut: read, plus New goal.
 * The routes' JSON becomes the model in goals_adapter.js, the words come from goal_words.js; everything drawn here is built with the DOM and textContent (no text from a goal or a task is read as markup).
 * Lazy: message_board.js imports it when the Goals face is chosen. */
import { state } from './state.js';
import { boardFetch, keyLabel, splitKey, LOCAL_SERVER } from './server_base.js';
import { setRowCurrent, OPERATOR_ID } from './utils.js';
import { browserLocal } from './safe_storage.js';
import { onGoalsSeq } from './goals_feed.js';
import { pollEvery } from './overload.js';
import { whenText } from './when_text.js';
import { toGoalList, mergeGoalLists, toTaskPage, toDrivers, createBody, errorOf, LIST_PATH } from './goals_adapter.js';

const PAGE = 50; // a goal's tasks are drawn this many at a time
import * as W from './goal_words.js';

const model = { project: '', sig: '', goals: [], requireGoal: false, noGoalOpen: null, filter: 'all', openId: 0, tasks: new Map(), loading: false, failed: '', asOf: '', creating: false };
let root = null;

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
    let same = false, focusHeading = false;
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
        model.sig = sig; model.goals = list.goals; model.requireGoal = list.requireGoal; model.noGoalOpen = list.noGoalOpen; model.failed = ''; model.asOf = clock();
        if (model.wantOpen) { const want = model.wantOpen; model.wantOpen = 0; if (model.goals.some(g => g.id === want)) { model.openId = want; same = false; focusHeading = true; } }
        if (model.openId && !model.goals.some(g => g.id === model.openId)) { model.openId = 0; same = false; }
    } catch (e) {
        if (project !== model.project) return;
        model.failed = W.failedText(e && e.message); model.sig = '';
    }
    model.loading = false;
    if (!same) draw();
    if (focusHeading) root.querySelector('#goals-detail-title')?.focus();
    if (model.openId) loadTasks(model.openId);
}

async function loadTasks(id) {
    try {
        const before = model.tasks.get(id);
        const want = before && before.rows ? before.shown : PAGE; // a refresh covers as many rows as were shown: the route answers a page of 50 and a cursor, so it reads pages until it has them (QA's #7196)
        let page = toTaskPage(await readJson(`/tasks?goal=${encodeURIComponent(id)}`));
        let rows = page.rows, cursor = page.cursor;
        for (let n = 0; cursor && rows.length < want && n < 40; n++) {
            page = toTaskPage(await readJson(`/tasks?goal=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`));
            rows = rows.concat(page.rows); cursor = page.cursor;
        }
        const sig = JSON.stringify([rows.map(r => [r.id, r.title, r.assignee, r.state, r.statusLine, r.sessionId]), cursor]);
        if (before && before.rows && before.sig === sig && !before.moreFailed) return; // the same tasks: nothing to draw again
        model.tasks.set(id, { rows, cursor, sig, shown: before && before.rows ? Math.max(before.shown, PAGE) : PAGE, moreFailed: '' }); // a refresh keeps how many were shown (#7142)
    } catch (e) {
        model.tasks.set(id, { failed: String((e && e.message) || '') });
    }
    if (model.openId === id) drawDetail();
}

/** Show the next page of a goal's tasks: from the rows already read, and from the route's cursor when it has sent one. */
async function showMoreTasks(id) {
    const t = model.tasks.get(id); if (!t || !t.rows) return;
    const before = t.shown;
    if (t.shown >= t.rows.length && t.cursor) {
        try {
            const page = toTaskPage(await readJson(`/tasks?goal=${encodeURIComponent(id)}&cursor=${encodeURIComponent(t.cursor)}`));
            t.rows = t.rows.concat(page.rows); t.cursor = page.cursor; t.moreFailed = '';
        } catch (e) { t.moreFailed = W.failedText(String((e && e.message) || '')).replace('Goals', 'More tasks'); drawDetail(); return; }
    }
    t.shown = Math.min(t.rows.length, t.shown + PAGE);
    drawDetail();
    say(W.tasksShownText(t.shown, taskTotal(goalById(id), t)));
    const first = root.querySelectorAll('.goal-task')[before]; // focus goes to the first task that was not there before
    if (first) first.focus();
}

/** How many tasks the goal has: the rollup's count (the route's own numbers), at least the rows read. */
const taskTotal = (goal, t) => Math.max(t.rows.length, goal ? goal.rollup.done + goal.rollup.active + goal.rollup.blocked + goal.rollup.queued : 0);

const goalById = (id) => model.goals.find(g => g.id === id);
const visible = () => model.goals.filter(g => W.keepsGoal(model.filter, g));

/** The live agent on this computer that is a task's assignee, or null (the button then says it is not running here). */
function agentFor(task) {
    const live = state.liveSessions || [];
    if (task.sessionId) { const bySession = live.find(s => s && s.session_id === task.sessionId); if (bySession) return bySession; }
    const name = task.assignee;
    if (!name) return null;
    return live.find(s => s && (s.board_project === model.project || !s.board_project) && (s.display_name === name || s.name === name)) || null;
}

function openTask(task) {
    const existing = state.currentBoardTasks || [];
    if (task.raw && !existing.find(t => t.id === task.id)) state.currentBoardTasks = [...existing, task.raw]; // showTaskDetailModal reads the task from here (the Analytics page does the same)
    window.showTaskDetailModal?.(task.id);
}

function openAgent(session) {
    window.switchNavTab?.('agents');
    window.selectLiveSession?.(session.name, session.agent_type, session.session_id, session.server);
}

// ── drawing ──────────────────────────────────────────────────────────────

function stateChip(goal) {
    const chip = el('span', `goal-chip goal-state-${goal.state || 'unknown'}`);
    chip.append(el('span', 'goal-dot'), document.createTextNode(W.stateWord(goal)));
    return chip;
}

function rollupBar(rollup) {
    const bar = el('span', 'goal-rollup'); bar.setAttribute('aria-hidden', 'true'); // the sentence beside the bar says the same: a reader hears it once (#7250)
    const sh = W.rollupShares(rollup);
    for (const k of ['done', 'active', 'blocked']) { if (!sh[k]) continue; const seg = el('span', `goal-rollup-${k}`); seg.style.width = `${(sh[k] * 100).toFixed(1)}%`; bar.append(seg); }
    return bar;
}

function goalCard(goal) {
    const li = el('li', 'goal-item');
    const b = el('button', 'row-btn goal-card'); b.type = 'button'; b.dataset.goalId = String(goal.id);
    const top = el('span', 'goal-card-top');
    top.append(el('span', 'goal-card-title', goal.title || `Goal ${goal.id}`), stateChip(goal));
    b.append(top);
    const meta = W.driverLine(goal.driver, whenText(goal.updatedAt));
    if (meta) b.append(el('span', 'goal-card-meta', meta));
    b.append(rollupBar(goal.rollup), el('span', 'goal-card-sentence', W.readyToClose(goal) ? W.readySentence(W.rollupSentence(goal.rollup)) : W.rollupSentence(goal.rollup)));
    b.addEventListener('click', () => openGoal(goal.id, true));
    li.append(b);
    setRowCurrent(li, goal.id === model.openId);
    return li;
}

function drawListRaw() {
    const col = root.querySelector('.goals-list-col'); if (!col) return;
    col.replaceChildren();
    const counts = W.filterCounts(model.goals);
    const chips = el('div', 'goals-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Show goals that are');
    for (const f of W.FILTERS) {
        const c = btn('goals-chip', `${W.filterLabel(f)} ${counts[f]}`, () => { model.filter = f; say(W.filterAnnouncement(f, counts[f])); drawList(); });
        c.setAttribute('aria-pressed', String(model.filter === f)); c.dataset.filter = f;
        if (!counts[f] && f !== 'all') c.classList.add('goals-chip-zero'); // still pressable, quieter than the chips that have goals
        chips.append(c);
    }
    col.append(chips);
    if (model.failed) {
        const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert');
        f.append(el('span', null, `${model.failed}${model.goals.length ? ` (${W.asOfText(model.asOf)})` : ''}`), btn('btn btn-small', 'Try again', loadGoals));
        col.append(f);
    }
    if (model.loading) { col.append(el('p', 'goals-note', 'Loading goals…')); return; }
    if (!model.goals.length) {
        if (!model.failed) {
            const e = el('div', 'goals-empty');
            e.append(el('p', null, W.noGoalsText)); // the header's New goal is the one button; no command line for a person (#7224)
            col.append(e);
        }
        return;
    }
    const shown = visible();
    if (!shown.length) {
        const fe = W.filteredEmpty(model.filter, model.goals.length);
        const e = el('div', 'goals-empty'); e.append(el('p', null, fe.text), btn('btn', fe.action, () => { model.filter = 'all'; say(W.filterAnnouncement('all', model.goals.length)); drawList(); }));
        col.append(e);
        return;
    }
    const ul = el('ul', 'goals-ul'); ul.setAttribute('aria-label', `Goals, ${shown.length}`);
    for (const g of shown) ul.append(goalCard(g));
    col.append(ul);
}

function taskRow(t) {
    const li = el('li', 'goal-task'); li.tabIndex = -1; // focus goes to the first task a Show more adds
    const head = el('span', 'goal-task-head');
    head.append(el('span', 'goal-task-id', `#${t.id}`), el('span', 'goal-task-title', t.title));
    const chip = el('span', `goal-chip goal-state-task-${W.taskStateWord(t.state).toLowerCase()}`); chip.append(el('span', 'goal-dot'), document.createTextNode(W.taskStateWord(t.state)));
    head.append(chip);
    li.append(head);
    const sub = [t.assignee, t.statusLine].filter(Boolean).join(' · ');
    if (sub) li.append(el('span', 'goal-task-sub', sub));
    const acts = el('span', 'goal-task-actions');
    const openT = btn('btn btn-small goal-open-task', 'Open task', () => openTask(t)); openT.setAttribute('aria-label', `Open task #${t.id}: ${t.title}`); // three rows, three names (the visible words start the name)
    acts.append(openT);
    if (W.taskStateWord(t.state) === 'Done') { li.append(acts); return li; } // a finished task has no agent to open: a long done list is not 120 repeats of "Not running here" (#7142)
    const session = agentFor(t);
    if (session) { const ob = btn('btn btn-small goal-open-agent', 'Open the agent', () => openAgent(session)); ob.setAttribute('aria-label', `Open the agent for task #${t.id}`); acts.append(ob); } // no agent here: no disabled button and no line on the row; the list says it once (#7224)
    li.append(acts);
    return li;
}

function drawDetailRaw() {
    const col = root.querySelector('.goals-detail-col'); if (!col) return;
    const keepFocus = document.activeElement && document.activeElement.id === 'goals-detail-title'; // the tasks arrive after the goal opens: the redraw must not take the focus off its heading
    col.replaceChildren();
    const g = goalById(model.openId);
    if (!g) { col.classList.add('goals-detail-none'); return; }
    col.classList.remove('goals-detail-none');
    const back = btn('goals-back', '‹ Goals', () => closeGoal());
    col.append(back);
    const h = el('h3', 'goals-detail-title', g.title); h.tabIndex = -1; h.id = 'goals-detail-title'; col.append(h);
    const line = el('div', 'goals-detail-line'); line.append(stateChip(g)); const meta = W.driverLine(g.driver, whenText(g.updatedAt)); if (meta) line.append(el('span', 'goal-card-meta', meta));
    if (W.isOpenGoal(g)) line.append(btn('btn btn-small goals-close', 'Close goal', () => openClose(g)));
    else if (W.isClosedGoal(g)) line.append(btn('btn btn-small goals-reopen', 'Reopen', () => reopenGoal(g)));
    col.append(line);
    if (g.outcome) { col.append(el('h4', 'goals-sub', 'Outcome'), el('p', 'goals-text', g.outcome)); }
    if (g.doneWhen) { col.append(el('h4', 'goals-sub', 'Done when'), el('p', 'goals-text', g.doneWhen)); }
    col.append(rollupBar(g.rollup), el('p', 'goal-card-sentence', W.rollupSentence(g.rollup)));
    const openLeft = g.rollup.active + g.rollup.blocked + g.rollup.queued;
    if ((g.state === 'done' || g.state === 'dropped') && openLeft) col.append(el('p', 'goals-note goals-closed-open', W.closedWithOpenText(openLeft)));
    if (W.readyToClose(g) && !isNotYet(g)) col.append(allDoneStrip(g));
    const tasks = model.tasks.get(g.id);
    if (!(tasks && tasks.rows && !tasks.rows.length)) col.append(el('h4', 'goals-sub', 'Tasks')); // a goal with no tasks says "No tasks yet" once, under its title (#7224)
    if (!tasks) col.append(el('p', 'goals-note', 'Loading tasks…'));
    else if (tasks.failed !== undefined) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, W.failedText(tasks.failed).replace('Goals', 'Tasks')), btn('btn btn-small', 'Try again', () => loadTasks(g.id))); col.append(f); }
    else if (!tasks.rows.length) { /* said by the rollup sentence above */ }
    else {
        const live = tasks.rows.filter(t => W.taskStateWord(t.state) !== 'Done'), idle = live.filter(t => !agentFor(t));
        if (idle.length) col.append(el('p', 'goals-note goals-nobody', W.nobodyWorkingText(idle.length, live.length)));
        const ul = el('ul', 'goal-tasks'); ul.setAttribute('aria-label', `Tasks of ${g.title}`); for (const t of tasks.rows.slice(0, tasks.shown)) ul.append(taskRow(t)); col.append(ul);
        const total = taskTotal(g, tasks), left = Math.max(tasks.rows.length - tasks.shown, 0) || (tasks.cursor ? Math.max(total - tasks.shown, 1) : 0);
        if (left) col.append(btn('btn goals-more', W.showMoreText(left, PAGE), () => showMoreTasks(g.id)));
        if (tasks.moreFailed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, tasks.moreFailed)); col.append(f); }
        if (left || tasks.shown < total) col.append(el('p', 'goals-note', !left && !tasks.cursor ? W.tasksCappedText(Math.min(tasks.shown, tasks.rows.length), total) : W.tasksShownText(Math.min(tasks.shown, tasks.rows.length), total)));
    }
    if (keepFocus) h.focus();
}

function drawHead() {
    const head = root.querySelector('.goals-head'); if (!head) return;
    head.replaceChildren();
    const left = el('div', 'goals-head-text');
    const h = el('h2', 'goals-title', 'Goals'); h.tabIndex = -1;
    left.append(h, el('p', 'goals-subtitle', W.goalsSubtitle), el('p', 'goals-sub-line', `This board only · ${W.goalCountLine(model.goals.length)}`));
    if (state.hubConnected || window.__goalsHub) left.append(el('p', 'goals-note', W.otherBoardsNote));
    head.append(left, btn('btn btn-primary goals-new', 'New goal', () => openCreate()));
    if (model.noGoalOpen > 0) left.append(el('p', 'goals-note goals-no-goal', W.noGoalTasksText(model.noGoalOpen))); // hidden while the route does not give the number
    if (model.requireGoal) head.after(Object.assign(el('p', 'goals-note goals-require'), { textContent: W.requireGoalNote }));
    else root.querySelector('.goals-require')?.remove();
}

/** Redraw a column and give the keyboard its place back: the control that had focus (a chip by its filter, a card by its goal, anything else by its class and words) is found again in the new draw; when it is gone ("Show all" and "Try again" go when they work) focus goes to the pressed chip, never to the page. */
function keepFocus(col, redraw) {
    const a = document.activeElement;
    const held = a && col && col.contains(a) && a !== col ? { filter: a.dataset.filter, goal: a.dataset.goalId, id: a.id, cls: a.className, text: a.textContent } : null;
    redraw();
    if (!held) return;
    const all = [...col.querySelectorAll('button, [tabindex]')];
    const same = held.filter ? col.querySelector(`.goals-chip[data-filter="${CSS.escape(held.filter)}"]`) : held.goal ? col.querySelector(`.goal-card[data-goal-id="${CSS.escape(held.goal)}"]`) : held.id ? col.querySelector(`#${CSS.escape(held.id)}`) : all.find(e => e.className === held.cls && e.textContent === held.text);
    (same || col.querySelector('.goals-chip[aria-pressed="true"]') || col.querySelector('#goals-detail-title'))?.focus({ preventScroll: true }); // gone because it worked: the pressed chip in the list, the goal's heading in the detail
}

const drawList = () => keepFocus(root && root.querySelector('.goals-list-col'), drawListRaw);
const drawDetail = () => keepFocus(root && root.querySelector('.goals-detail-col'), drawDetailRaw);

function draw() {
    if (!root) return;
    drawHead(); drawList(); drawDetail();
    root.classList.toggle('goals-open', !!model.openId && !!goalById(model.openId));
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
    draw();
    if (focus) root.querySelector('#goals-detail-title')?.focus();
    if (!model.tasks.has(id) || model.tasks.get(id).failed !== undefined) loadTasks(id);
}

function closeGoal() {
    const id = model.openId;
    model.openId = 0;
    draw();
    root.querySelector(`.goal-card[data-goal-id="${id}"]`)?.focus();
}

// ── New goal ─────────────────────────────────────────────────────────────

function openCreate() {
    if (model.creating) return;
    model.creating = true;
    const dlg = document.createElement('dialog'); dlg.className = 'goals-dialog'; dlg.setAttribute('aria-labelledby', 'goals-create-title');
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

// ── closing, reopening, and the all-done prompt (#7272, UI/UX's #7270) ─────

const NOT_YET_KEY = 'coral.goals.notyet';
const notYetKey = (g) => `${model.project}|${g.id}|${W.allTasksOf(g.rollup)}`; // per goal and task total: it comes back when a task is added or removed
function notYetList() { try { const v = JSON.parse(browserLocal.get(NOT_YET_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
const isNotYet = (g) => notYetList().includes(notYetKey(g));
function setNotYet(g) { try { browserLocal.set(NOT_YET_KEY, JSON.stringify([...notYetList().filter(k => k !== notYetKey(g)), notYetKey(g)].slice(-100))); } catch { /* the strip comes back on the next read */ } }

/** The prompt above Tasks when every task of an active goal is done: a labelled region (not an alert), Close as done and Not yet. */
function allDoneStrip(g) {
    const s = el('section', 'goals-alldone'); s.setAttribute('aria-label', 'All tasks done');
    const words = el('p', 'goals-alldone-text'); words.append(el('strong', null, W.allDoneLine(W.allTasksOf(g.rollup))), document.createTextNode(` ${W.allDoneAsk(g.doneWhen)}`));
    const acts = el('div', 'goals-alldone-actions');
    acts.append(btn('btn btn-primary btn-small goals-alldone-close', 'Close as done', () => openClose(g, 'done')), btn('btn btn-small goals-alldone-not-yet', 'Not yet', () => { setNotYet(g); drawDetail(); say(W.notYetSaid); root.querySelector('#goals-detail-title')?.focus(); }));
    s.append(words, acts, el('p', 'goals-note', W.notYetHint));
    return s;
}

async function reopenGoal(g) {
    try {
        const r = await boardFetch(model.project, `/goals/${g.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, state: 'active' }) });
        if (!r.ok) throw await failure(r);
        say(W.reopenedText);
        await loadGoals();
    } catch (ex) { say(`Not reopened: ${W.errorWords(ex && ex.code, ex && ex.message)}`); }
    root.querySelector('#goals-detail-title')?.focus();
}

/** The Close dialog: a real dialog (focus trapped, Escape closes), described by the open-tasks warning when there is one. `preset` chooses Done (the all-done strip). */
function openClose(g, preset) {
    if (model.creating) return;
    model.creating = true;
    const open = W.openTasksOf(g.rollup), total = W.allTasksOf(g.rollup);
    const dlg = document.createElement('dialog'); dlg.className = 'goals-dialog goals-close-dialog'; dlg.setAttribute('aria-labelledby', 'goals-close-title');
    const form = el('form', 'goals-form'); form.noValidate = true;
    const title = el('h3', null, W.closeTitle); title.id = 'goals-close-title';
    const parts = [title, el('p', 'goals-close-goal', g.title)];
    if (open) {
        const warn = el('div', 'goals-warning'); warn.id = 'goals-close-warning';
        const w = W.closeWarning(g.rollup); warn.append(el('strong', null, w.head), document.createTextNode(w.text));
        dlg.setAttribute('aria-describedby', warn.id); parts.push(warn);
    }
    const choose = preset || (open === 0 && total > 0 ? 'done' : 'dropped');
    const fs = el('fieldset', 'goals-radios'); fs.append(el('legend', null, 'Close it as'));
    const radio = (value, label) => { const l = el('label', 'goals-radio'); const r = el('input'); r.type = 'radio'; r.name = 'goal-close-state'; r.value = value; r.checked = choose === value; l.append(r, el('span', null, label)); return l; };
    fs.append(radio('done', W.closeDoneLabel), radio('dropped', W.closeDroppedLabel));
    const reason = el('input'); reason.type = 'text'; reason.maxLength = 300; reason.autocomplete = 'off'; reason.id = 'goal-close-reason';
    const rl = el('label', 'goals-field'); rl.append(el('span', null, W.closeReasonLabel), reason);
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert'); err.id = 'goal-close-error';
    const go = btn('btn btn-primary', 'Close goal'); go.type = 'submit';
    const actions = el('div', 'goals-actions'); actions.append(btn('btn', 'Cancel', () => dlg.close()), go);
    form.append(...parts, fs, rl, err, actions);
    dlg.append(form); document.body.append(dlg);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!reason.value.trim()) { err.textContent = W.closeReasonNeeded; reason.setAttribute('aria-invalid', 'true'); reason.setAttribute('aria-describedby', err.id); reason.focus(); return; }
        reason.removeAttribute('aria-invalid'); reason.removeAttribute('aria-describedby'); go.disabled = true;
        const as = form.querySelector('input[name="goal-close-state"]:checked')?.value === 'dropped' ? 'dropped' : 'done';
        try {
            const r = await boardFetch(model.project, `/goals/${g.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, reason: reason.value.trim(), state: as }) });
            if (!r.ok) throw await failure(r);
            dlg.close();
            say(W.closedAsText(as, open));
            await loadGoals();
            root.querySelector('#goals-detail-title')?.focus();
        } catch (ex) {
            if (ex && ex.code === 'goal_already_closed') { dlg.close(); say(W.alreadyClosedText); await loadGoals(); return; }
            err.textContent = `The goal was not closed: ${W.errorWords(ex && ex.code, ex && ex.message)}`; go.disabled = false;
        }
    });
    dlg.addEventListener('close', () => { model.creating = false; dlg.remove(); (root.querySelector('.goals-close') || root.querySelector('#goals-detail-title'))?.focus(); });
    dlg.showModal(); (form.querySelector('input[name="goal-close-state"]:checked') || reason).focus();
}

// ── showing and hiding ───────────────────────────────────────────────────

/** Show the board's goals in `host` (the page's #mb-goals) and read them. */
export function showGoals(host, project) {
    if (project !== model.project) { Object.assign(model, { project, sig: '', goals: [], requireGoal: false, noGoalOpen: null, filter: 'all', openId: 0, tasks: new Map(), failed: '', asOf: '', loading: false }); }
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const page = el('div', 'goals-page');
        const status = el('div', 'goals-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const cols = el('div', 'goals-cols');
        const listCol = el('section', 'goals-list-col'), detailCol = el('section', 'goals-detail-col');
        listCol.setAttribute('aria-label', 'Goals'); detailCol.setAttribute('aria-label', 'Goal detail');
        cols.append(listCol, detailCol);
        page.append(el('div', 'goals-head'), status, cols);
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
