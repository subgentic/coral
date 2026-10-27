// One goal's detail view, shared by the team Goals list and other page hosts.
import { openTask } from './task_navigation.js';
import { boardFetch, keyLabel } from './server_base.js';
import { OPERATOR_ID } from './utils.js';
import { browserLocal } from './safe_storage.js';
import { whenText } from './when_text.js';
import { toTaskPage, toGoal, errorOf } from './goals_adapter.js';
import { importOnce } from './import_once.js';
import { foldWayBack } from './way_back.js';
import * as W from './goal_words.js';
import { onGoalsSeq } from './goals_feed.js';
import { pollEvery } from './overload.js';
const { attachDockResize, DOCK_MIN_WIDTH, dockMaxWidth } = await importOnce('./dock_resize.js');
const DT = await importOnce('./data_table.js');
const TV = await importOnce('./tasks_view.js');
const PAGE = 50;

/** Mount one goal; each mount owns its task pages, search and phone screen. */
export function mountGoal(host, { team, id, back, onTask, goal, refresh, status, teamLink, focusOnOpen = true }) { // focusOnOpen: false where the page opens in place and the heading should not take the focus (the Inbox, #8681)
    const root = host;
    const model = { project: team, openId: id, tasks: new Map(), followUps: new Map(), followKey: new Map(), taskSearch: '', screen: 'goal', creating: false };
    let current = goal;
    let disposed = false;
    const goalById = gid => current?.id === gid ? current : null;
    const doneOf = rollup => rollup.done, totalOf = rollup => W.allTasksOf(rollup);
    const closeGoal = () => back();
    const drawPage = () => { if (!disposed && current) drawGoalPageRaw(root); };
    const drawDetail = drawPage;
    const focusDetail = () => root.querySelector('#goals-detail-title')?.focus({ preventScroll: true });
    const loadGoals = () => refresh ? refresh() : reload();
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
    const say = text => status?.(text);

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
        if (!disposed && model.openId === id) drawDetail();
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
        const first = root.querySelectorAll('.goals-detail-col .dt-primary')[before]; // focus goes to the first task that was not there before
        if (first) first.focus();
    }

    /** How many tasks the goal has: the rollup's count (the route's own numbers), at least the rows read. */
    const taskTotal = (goal, t) => Math.max(t.rows.length, goal ? goal.rollup.done + goal.rollup.active + goal.rollup.blocked + goal.rollup.queued : 0);

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

    function backButton(text, onClick) {
        const b = btn('goals-back', null, onClick);
        const arrow = el('span', 'goals-back-arrow', '←'); arrow.setAttribute('aria-hidden', 'true');
        b.append(arrow, document.createTextNode(` ${text}`));
        return b;
    }

    // ── a goal's page: its details beside its tasks (#7665) ──────────────────────────────────────────────────────────────────
    // The goal's details are the main pane; its tasks are a column of their own at the right (search, Open then Done, a state chip and who did the work on each row); a task picked from the column is the #7644 task page in the
    // main pane, with a way back to the goal. On a phone the goal, its list and a task are three screens (model.screen).

    const whoOf = (t) => t.workedBy || (isDone(t) && t.raw && t.raw.completed_by) || t.assignee; // who did the work: the author of a reviewed task, not the orchestrator it was handed to
    const isDone = (t) => W.taskStateWord(t.state) === 'Done';

    /** The rollup and the rows are read separately: while they disagree (the rollup is fresh, the rows are the last read) the page says it is updating, so two moments are never drawn as one (UI/UX, #7513). */
    function rowsAgree(g) {
        const tasks = model.tasks.get(g.id), total = totalOf(g.rollup);
        return !tasks || tasks.rows === undefined || !!tasks.cursor || (tasks.rows.length === total && tasks.rows.filter(isDone).length === g.rollup.done);
    }

    function drawGoalMain(main, g) {
        main.append(backButton('Goals', () => closeGoal()));
        if (teamLink) {
            const link = el('a', 'goal-team-link', 'Open on team page'); link.href = teamLink;
            link.setAttribute('aria-label', `Open ${keyLabel(team)} on team page`);
            link.addEventListener('click', e => {
                if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                importOnce('./task_goals.js').then(m => m.openGoalOnTeamPage(team, id));
            });
            const row = el('div', 'goal-back-row');
            row.append(main.querySelector('.goals-back'), link); main.append(row);
        }
        const h = el('h2', 'goals-detail-title', g.title); h.tabIndex = -1; h.id = 'goals-detail-title';
        const backRow = main.querySelector(':scope > .goal-back-row');
        (backRow || main).append(h); // with the team link the title is in the way-back row: a phone puts the back beside it and the link under (team_page.css), as on the task page
        foldWayBack(main, '.goals-back', '.goals-detail-title');
        const line = el('div', 'goals-detail-line'); line.append(stateChip(g));
        const meta = W.driverLine(g.driver, whenText(g.updatedAt)); if (meta) line.append(el('span', 'goal-card-meta', meta));
        main.append(line);
        if (g.outcome || g.doneWhen) {
            const dl = el('dl', 'goals-facts');
            if (g.outcome) dl.append(el('dt', null, 'Outcome'), el('dd', null, g.outcome));
            if (g.doneWhen) dl.append(el('dt', null, 'Done when'), el('dd', null, g.doneWhen));
            main.append(dl);
        }
        const openLeft = g.rollup.active + g.rollup.blocked + g.rollup.queued;
        if ((g.state === 'done' || g.state === 'dropped') && openLeft) main.append(el('p', 'goals-note goals-closed-open', W.closedWithOpenText(openLeft)));
        if (W.readyToClose(g) && !isNotYet(g)) { main.append(allDoneStrip(g)); announceAllDone(g); }
        const total = totalOf(g.rollup);
        // "2 of 3 tasks done" (#7878): "3 tasks" is a link to the team Tasks tab with this goal chosen
        const progress = el('p', 'goals-tasks-head goals-progress');
        if (total) {
            const noun = `${total} ${total === 1 ? 'task' : 'tasks'}`, link = btn('goals-tasks-link', noun, () => window.openTeamPage?.(model.project, { tab: 'tasks', query: `goal=${g.id}` }));
            link.setAttribute('aria-label', `${noun}: show them in the Tasks tab`);
            progress.append(document.createTextNode(`${doneOf(g.rollup)} of `), link, document.createTextNode(' done'));
        } else progress.textContent = 'No tasks yet';
        main.append(progress);
        if (total) main.append(rollupBar(g.rollup));
        main.append(el('p', 'goals-note goals-updating', rowsAgree(g) ? '' : 'Updating…')); // the column says it too, and is aria-busy
        const tasks = model.tasks.get(g.id);
        if (tasks && tasks.rows) { // on a phone the list is the next screen: its way in
            const go = btn('btn goal-tasks-open', '', () => { model.screen = 'column'; drawPage(); focusHeading('.goal-side-back'); });
            go.append(el('span', 'goal-tasks-label', 'Tasks'), el('span', 'goal-tasks-counts', `${openLeft} open, ${g.rollup.done} done`), el('span', 'goal-tasks-chevron')); // a phone's way into the list: the button look, the counts beside the label, a chevron at the edge (#8681)
            go.setAttribute('aria-label', `Tasks, ${openLeft} open, ${g.rollup.done} done`); go.querySelector('.goal-tasks-chevron').setAttribute('aria-hidden', 'true');
            main.append(go);
        }
        // The pinned bar: Add task and Close goal (Reopen for a closed one), always at the bottom of the page.
        const bar = el('div', 'goals-pinbar');
        bar.append(btn('btn goals-add-task', 'Add task', () => { (window.showCreateTaskModal || (() => {}))({ project: model.project, goal_id: g.id, onCreated: loadGoals }); }));
        if (W.isOpenGoal(g)) { const cb = btn('btn btn-primary goals-close', 'Close goal', () => openClose(g)); cb.setAttribute('aria-label', `Close goal: ${g.title}`); bar.append(cb); } // named for its goal: the Close dialog's own button is just Close goal
        else if (W.isClosedGoal(g)) bar.append(btn('btn goals-reopen', 'Reopen', () => reopenGoal(g)));
        main.append(artifactsHost(g)); // below the progress and the task button, above the pinned bar
        main.append(bar);
        return h;
    }

    const focusHeading = (sel) => requestAnimationFrame(() => root && root.querySelector(sel)?.focus({ preventScroll: true }));

    /** The column's counts: the open and done tasks, and the follow-ups still open when there are any (#7816). */
    function sideCounts(g) {
        const r = g.rollup, openN = r.active + r.blocked + r.queued, fu = model.followUps.get(g.id) || 0;
        return `${openN} open, ${r.done} done${fu ? `, ${W.followUpsOpenText(fu)}` : ''}`;
    }

    /** The server counts a goal's open follow-ups where one goal is read (never in the list): read it again when the goal's tasks change, and say it in the column's head. */
    function readFollowUps(g) {
        const key = JSON.stringify([g.id, g.rollup, g.updatedAt]);
        if (model.followKey.get(g.id) === key) return;
        model.followKey.set(g.id, key);
        const project = model.project;
        readJson(`/goals/${g.id}`).then(one => {
            if (disposed || project !== model.project) return;
            const n = Number(one && one.follow_ups_open) || 0;
            if (n === (model.followUps.get(g.id) || 0)) return;
            model.followUps.set(g.id, n);
            const counts = model.openId === g.id && root && root.querySelector('.goal-side-counts'); if (counts) counts.textContent = sideCounts(goalById(g.id) || g);
        }).catch(() => { model.followKey.delete(g.id); }); // a failed read is tried again at the next drawing; the count is not made up
    }

    /** The task column: header with the counts, search, Open then Done, each row a button that opens the task in the main pane. */
    function drawGoalSide(side, g) {
        side.replaceChildren();
        const r = g.rollup, openN = r.active + r.blocked + r.queued;
        const back = backButton(`Goal: ${g.title}`, () => { model.screen = 'goal'; drawPage(); focusHeading('.goal-tasks-open'); }); back.classList.add('goal-side-back'); // a phone's way back from the list to the goal
        const head = el('div', 'goal-side-head'); head.append(el('strong', null, 'Tasks'), el('span', 'goal-side-counts', sideCounts(g)));
        readFollowUps(g);
        const search = el('input', 'goal-side-search'); search.type = 'search'; search.placeholder = 'Search tasks'; search.autocomplete = 'off'; search.maxLength = 100;
        search.setAttribute('aria-label', `Search the tasks of ${g.title}`); search.value = model.taskSearch;
        const list = el('div', 'goal-side-list');
        if (!rowsAgree(g)) list.setAttribute('aria-busy', 'true');
        side.append(back, head, search, list);
        const tasks = model.tasks.get(g.id);
        const fill = () => {
            list.replaceChildren();
            if (!tasks) { list.append(el('p', 'goals-note', 'Loading tasks…')); return; }
            if (tasks.failed !== undefined) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, W.failedText(tasks.failed).replace('Goals', 'Tasks')), btn('btn btn-small', 'Try again', () => loadTasks(g.id))); list.append(f); return; }
            if (!tasks.rows.length) { list.append(el('p', 'goals-note', 'No tasks yet')); return; }
            const q = model.taskSearch.trim().toLowerCase();
            const shown = tasks.rows.slice(0, tasks.shown).filter(t => !q || `#${t.id} ${t.title} ${whoOf(t)}`.toLowerCase().includes(q));
            if (!shown.length) { list.append(el('p', 'goals-note', `No task matches "${model.taskSearch.trim()}"`)); }
            const groups = [['Open', shown.filter(t => !isDone(t))], ['Done', shown.filter(isDone).sort((a, b) => b.id - a.id)]]; // the newest done task first
            for (const [name, rows] of groups) {
                if (!rows.length) continue;
                const head = el('h3', 'goal-side-group', `${name} ${rows.length}`);
                list.append(head, sideTable(g, name, rows).el);
            }
            const total = taskTotal(g, tasks), left = Math.max(tasks.rows.length - tasks.shown, 0) || (tasks.cursor ? Math.max(total - tasks.shown, 1) : 0);
            if (left) list.append(btn('btn goals-more', W.showMoreText(left, PAGE), () => showMoreTasks(g.id)));
            if (tasks.moreFailed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, tasks.moreFailed)); list.append(f); }
        };
        fill();
        search.addEventListener('input', () => { model.taskSearch = search.value; fill(); });
    }

    /** A goal's row as the board's task record the columns read. */
    function taskOf(t) {
        const raw = t.raw || {};
        return { ...raw, id: t.id, title: t.title, status: raw.status || t.state, worked_by: t.workedBy || raw.worked_by, assigned_to: raw.assigned_to ?? t.assignee };
    }

    /** A group of the column (Open, Done): the one table, folded to its two-line row in the column's narrow box. */
    function sideTable(g, name, rows) {
        return TV.tasksTable('goal', rows.map(taskOf), { label: `${name} tasks of ${g.title}`, ctx: { goalTitleOf: (gid) => (goalById(gid) || {}).title || `Goal ${gid}` },
            open: task => onTask ? onTask(task, g) : openTask(model.project, task.id), sortBar: false, bare: true, state: sideState(g.id, name) });
    }
    const sideStates = new Map();
    const sideState = (gid, name) => { const k = `${gid}:${name}`; if (!sideStates.has(k)) sideStates.set(k, DT.tableState()); return sideStates.get(k); };

    /** The separator's value for a screen reader: the column's width and its limits (the dock's, dock_resize.js). */
    function gripValue(grip, split, side) {
        grip.setAttribute('aria-valuemin', String(DOCK_MIN_WIDTH)); grip.setAttribute('aria-valuemax', String(dockMaxWidth(split)));
        grip.setAttribute('aria-valuenow', String(Math.round(side.getBoundingClientRect().width)));
    }

    function drawGoalPageRaw(col) {
        const g = goalById(model.openId);
        const keep = document.activeElement && document.activeElement.id === 'goals-detail-title';
        col.replaceChildren();
        const split = el('div', 'goal-split'); split.dataset.goal = String(g.id); split.classList.toggle('goal-split-column', model.screen === 'column');
        const main = el('div', 'goal-main'), side = el('aside', 'goal-side'); side.setAttribute('aria-label', `Tasks of ${g.title}`);
        const grip = el('div', 'goal-side-grip'); grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical'); grip.setAttribute('aria-label', 'Resize the task list'); grip.tabIndex = 0; grip.title = 'Drag to resize, double click to reset';
        split.append(main, side, grip); col.append(split);
        attachDockResize(grip, { panel: side, row: split, key: 'coral-goal-side-width', apply: (w) => { split.style.setProperty('--goal-side-w', w ? `${w}px` : ''); gripValue(grip, split, side); } }).restore();
        drawGoalSide(side, g);
        const h = drawGoalMain(main, g);
        if (keep) h.focus();
    }

    // ── closing, reopening, and the all-done prompt (#7272, UI/UX's #7270) ─────

    const NOT_YET_KEY = 'coral.goals.notyet';
    const notYetKey = (g) => `${model.project}|${g.id}|${W.allTasksOf(g.rollup)}`; // per goal and task total: it comes back when a task is added or removed
    function notYetList() { try { const v = JSON.parse(browserLocal.get(NOT_YET_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
    const isNotYet = (g) => notYetList().includes(notYetKey(g));
    const announcedDone = new Set(); // the all-done strips already said, by goal and task total: said once when it first appears, not on every redraw
    function announceAllDone(g) { const k = notYetKey(g); if (announcedDone.has(k)) return; announcedDone.add(k); say(W.allDoneSaid(W.allTasksOf(g.rollup), g.title)); }
    function setNotYet(g) { try { browserLocal.set(NOT_YET_KEY, JSON.stringify([...notYetList().filter(k => k !== notYetKey(g)), notYetKey(g)].slice(-100))); } catch { /* the strip comes back on the next read */ } }

    /** The prompt above Tasks when every task of an active goal is done: a labelled region (not an alert), Close as done and Not yet. */
    function allDoneStrip(g) {
        const s = el('section', 'goals-alldone'); s.setAttribute('aria-label', 'All tasks done');
        const words = el('p', 'goals-alldone-text'); words.append(el('strong', null, W.allDoneLine(W.allTasksOf(g.rollup))), document.createTextNode(` ${W.allDoneAsk(g.doneWhen)}`));
        const acts = el('div', 'goals-alldone-actions');
        acts.append(btn('btn btn-primary btn-small goals-alldone-close', 'Close as done', () => openClose(g, 'done')), btn('btn btn-small goals-alldone-not-yet', 'Not yet', () => { setNotYet(g); drawDetail(); say(W.notYetSaid); focusDetail(); }));
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
        focusDetail();
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
        const reason = el('input'); reason.type = 'text'; reason.maxLength = 300; reason.autocomplete = 'off'; reason.id = 'goal-close-reason'; reason.required = true; reason.setAttribute('aria-required', 'true');
        const hint = el('span', 'goals-note', W.closeReasonHint); hint.id = 'goal-close-hint'; reason.setAttribute('aria-describedby', hint.id);
        const rl = el('label', 'goals-field'); rl.append(el('span', null, W.closeReasonLabel), reason, hint);
        const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert'); err.id = 'goal-close-error';
        const go = btn('btn btn-primary', 'Close goal'); go.type = 'submit';
        const actions = el('div', 'goals-actions'); actions.append(btn('btn', 'Cancel', () => dlg.close()), go);
        form.append(...parts, fs, rl, err, actions);
        dlg.append(form); document.body.append(dlg);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            err.textContent = '';
            if (!reason.value.trim()) { err.textContent = W.closeReasonNeeded; reason.setAttribute('aria-invalid', 'true'); reason.setAttribute('aria-describedby', `${hint.id} ${err.id}`); reason.focus(); return; }
            reason.removeAttribute('aria-invalid'); reason.setAttribute('aria-describedby', hint.id); go.disabled = true;
            const as = form.querySelector('input[name="goal-close-state"]:checked')?.value === 'dropped' ? 'dropped' : 'done';
            try {
                const r = await boardFetch(model.project, `/goals/${g.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: OPERATOR_ID, reason: reason.value.trim(), state: as }) });
                if (!r.ok) throw await failure(r);
                dlg.close();
                say(W.closedAsText(as, open));
                await loadGoals();
                focusDetail();
            } catch (ex) {
                if (ex && ex.code === 'goal_already_closed') { dlg.close(); say(W.alreadyClosedText); await loadGoals(); return; }
                err.textContent = `The goal was not closed: ${W.errorWords(ex && ex.code, ex && ex.message)}`; go.disabled = false;
            }
        });
        dlg.addEventListener('close', () => { model.creating = false; dlg.remove(); (root.querySelector('.goals-close') || root.querySelector('.goals-detail-col'))?.focus(); });
        dlg.showModal(); (form.querySelector('input[name="goal-close-state"]:checked') || reason).focus();
    }


    // The goal's Artifacts (#8616): one mount for the goal on show, its node moved into each drawing of the page, so what is open and loaded stays while the page is drawn again
    const artifacts = { id: 0, host: null, api: null };
    function artifactsHost(g) {
        if (artifacts.id !== g.id) {
            artifacts.api?.destroy(); artifacts.api = null;
            const host = artifacts.host = el('div', 'goal-artifacts-host'); artifacts.id = g.id;
            importOnce('./goal_artifacts.js').then(m => { if (!disposed && artifacts.host === host) artifacts.api = m.mountGoalArtifacts(host, { team: model.project, goalId: g.id }); }).catch(() => {}); // no section when it cannot load
        }
        return artifacts.host;
    }
    const update = g => { const again = current && current.id === g.id && JSON.stringify(current.rollup) !== JSON.stringify(g.rollup); current = g; drawPage(); if (again) artifacts.api?.refresh(); }; // the tasks moved: their files may have
    let reading = false, again = false, signature = '', first = true;
    async function reload() {
        if (disposed) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
            const json = await readJson(`/goals/${id}`);
            if (disposed) return;
            const g = toGoal(json.goal || json);
            if (!g || g.id !== id) throw new Error('That goal was not found');
            const next = JSON.stringify(g);
            if (next !== signature) { signature = next; update(g); }
            if (first) { first = false; if (focusOnOpen) focusDetail(); }
            await loadTasks(id);
        } catch (e) {
            if (disposed) return;
            const problem = el('div', 'goals-failed'); problem.setAttribute('role', 'alert');
            problem.append(el('span', null, W.failedText(e.message)), btn('btn btn-small', 'Try again', reload));
            if (!current) { root.replaceChildren(backButton('Goals', back), problem); }
            else { root.querySelector(':scope > .goals-failed')?.remove(); root.prepend(problem); }
        } finally { reading = false; if (again && !disposed) { again = false; reload(); } }
    }
    const visibleRefresh = () => { if (!disposed && root.isConnected && root.getClientRects().length) reload(); };
    let stop = null, timer = null;
    if (goal) update(goal);
    else {
        root.replaceChildren(backButton('Goals', back), el('p', 'goals-note', 'Loading goal…'));
        reload();
        stop = onGoalsSeq(board => { if (board === team) visibleRefresh(); });
        timer = pollEvery(visibleRefresh, 30000);
        window.addEventListener('focus', visibleRefresh);
    }
    return { update, refreshTasks: () => loadTasks(id), dispose: () => {
        disposed = true; artifacts.api?.destroy(); stop?.(); if (timer) clearInterval(timer); window.removeEventListener('focus', visibleRefresh);
    }, focus: focusDetail };
}
