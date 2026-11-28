/* The agent list grouped by status (#21466, the Operator's approved mock, concept mocks v3 idea 4): Needs you, Working, Idle and Done today (folded), the newest update first inside each group.
 * The group heading carries the status shape, so a row here has no dot of its own. Status is the default; Team (the orchestrator-folded view, group_cards.js) is the other choice, and the
 * choice is remembered per viewer. On a phone the list is short: every agent that needs you, two that are working, and one line that counts the rest ("2 more working · 3 idle · 6 done today").
 * Loaded when the list draws (render.js asks for it), so the first paint carries none of these bytes; its rules are in the start sheet (css/status_groups.css, last before forced-colors), paid for by the theme editor's sheet going lazy. */
import { browserLocal } from './safe_storage.js';
import { registerActions, tokenOf, textOf } from './actions.js';
import { redrawLiveList } from './list_hooks.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { isPhoneLayout } from './phone_layout.js';
import { sessionStateInfo } from './session_state.js';
import { DISPLAY_PANEL_OPEN } from './display_panel.js';
import { loadStyles } from './lazy_styles.js';
const groupByStyles = () => loadStyles('group_by.css'); // the Group by boxes and the task split: a request of their own the first time the Display panel opens or a task split draws, not at start (#21685)

const KEYS = { server: 'coral-group-computer', team: 'coral-group-team', task: 'coral-group-task' }; // 'true' / 'false' per box; none set = the old choices (below), else all off
const LEGACY = { server: ['coral-group-by-server', 'true'], team: ['coral-agent-grouping', 'team'] }; // what a browser chose before the three boxes
const FOLD = 'coral-status-folded'; // JSON: the groups the person opened or folded by hand
const MORE = 'coral-status-more'; // the phone's one line is open
const DAY = 86400;
const SHAPE = { needs: 'st-needs', working: 'st-working', idle: 'st-idle', done: 'st-done' };
const WORKERS_MIN = 4; // a team folds its workers under the orchestrator from this many
const PHONE_WORKING = 2; // working agents a phone shows before the line that counts the rest
const GROUPS = [['needs', 'Needs you'], ['working', 'Working'], ['idle', 'Idle'], ['done', 'Done today']];

const read = (k, d) => { try { return browserLocal.get(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { browserLocal.set(k, v); } catch { /* per-viewer only */ } };

/** Group by (#21685, the Operator's approved mock v4): three check boxes in the agent list's Display panel, above the count: Computer, Team, Task. Ticked ones nest in that order (computer, then team,
 *  then task); none ticked is the Status view. Added to the sidebar's bar and the phone's (agent_list_bar.js builds them) at every draw and when the panel opens, so no start byte carries it.
 *  They replace the Status | Team select (#21683) and the Display panel's "Group by computer" switch. */
const BOXES = [['server', 'Computer'], ['team', 'Team'], ['task', 'Task']];
function mountGroupBy(e) {
    if (e && e.type === DISPLAY_PANEL_OPEN) groupByStyles(); // the panel is opening: the boxes are about to show
    for (const id of ['agent-list-bar', 'mobile-agent-list-bar']) {
        const menu = document.querySelector(`#${id} .list-bar-menu`);
        if (!menu) continue;
        let box = menu.querySelector('fieldset[data-group-by]');
        if (!box) {
            box = document.createElement('fieldset'); box.className = 'list-bar-groupby'; box.setAttribute('data-group-by', '');
            const legend = document.createElement('legend'); legend.className = 'list-bar-field-label'; legend.textContent = 'Group by'; box.append(legend);
            for (const [k, label] of BOXES) {
                const row = document.createElement('label'), input = document.createElement('input');
                row.className = 'list-bar-check'; input.type = 'checkbox'; input.id = `${id}-group-${k}`; input.dataset.box = k;
                input.addEventListener('change', () => { write(KEYS[k], String(input.checked)); syncBoxes(); redrawLiveList(); });
                row.append(input, document.createTextNode(label)); box.append(row);
            }
            menu.insertBefore(box, menu.querySelector('.list-bar-count'));
        }
    }
    syncBoxes();
}
const syncBoxes = () => { const g = groupBy(); for (const input of document.querySelectorAll('fieldset[data-group-by] input[data-box]')) if (input.checked !== g[input.dataset.box]) input.checked = g[input.dataset.box]; }; // the sidebar's bar and the phone's show the one choice
document.addEventListener(DISPLAY_PANEL_OPEN, mountGroupBy);

/** Which boxes are ticked: { server (the Computer box), team, task }. All off unless chosen; a browser that chose Team or Group by computer before the boxes keeps that choice. */
export function groupBy() {
    const on = k => { const v = read(KEYS[k], null); if (v !== null) return v === 'true'; const old = LEGACY[k]; return !!old && read(old[0], null) === old[1]; };
    return { server: on('server'), team: on('team'), task: on('task') };
}

const foldedMap = () => { try { return JSON.parse(read(FOLD, '{}')) || {}; } catch { return {}; } };
const isFolded = key => (key in foldedMap() ? !!foldedMap()[key] : key === 'done' || key.startsWith('w:') || key.startsWith('d:') || key.startsWith('m:')); // Done today, a team's workers and a phone's short lists are folded until opened

/** The group an agent is in (an archived one is Done). */
export function groupOf(s) {
    if (s.archived) return 'done';
    const info = sessionStateInfo(s);
    if (info.attention) return 'needs';
    return info.key === 'working' ? 'working' : 'idle';
}

/** An archived agent that was active in the last day (the Done today group). */
export const doneToday = s => !!s.archived && age(s) < DAY;
const age = s => (s.staleness_seconds === null || s.staleness_seconds === undefined ? Infinity : s.staleness_seconds);
const longAgo = sec => (sec === Infinity ? '' : sec < 60 ? 'now' : sec < 3600 ? `${Math.floor(sec / 60)} min` : sec < DAY ? `${Math.floor(sec / 3600)} h` : `${Math.floor(sec / DAY)} d`);

/** A row of the list: the shared agent row, its time said as the mock does ("6 min"), with no drag (the order is the time) and no dot (the heading is the status). */
function rowHtml(s, renderRow) {
    return renderRow(s, '__status__', false, false, '')
        .replace(/(<span class="session-time"[^>]*>)[^<]*/, `$1${escapeHtml(longAgo(age(s)))}`)
        .replace('draggable="true"', 'draggable="false"')
        .replace('data-group="__status__"', `data-group="__status__"${groupOf(s) === 'needs' ? ' data-need="1"' : ''}`); // under "Needs you" the "Needs input" chip says it twice
}

function headHtml(key, label, n, folded) {
    return `<li class="status-head" data-status="${escapeAttr(key)}"><button type="button" class="btn btn-quiet status-head-toggle" data-on-click="status-fold" data-group="${escapeAttr(key)}" aria-expanded="${escapeAttr(String(!folded))}">`
        + `<span class="status-caret" aria-hidden="true"></span><span class="status-shape ${escapeAttr(SHAPE[key])}" aria-hidden="true"></span><span class="status-name">${escapeHtml(label)}</span><span class="session-group-count">${Number(n)}</span></button></li>`;
}

/** The list as markup. sessions: every agent to draw, archived ones included (they are the Done today group when they were active in the last day); renderRow: _renderSessionItem. */
export function renderStatusGroups(sessions, renderRow) {
    const by = { needs: [], working: [], idle: [], done: [] };
    for (const s of sessions) {
        const g = groupOf(s);
        by[g].push(s);
    }
    for (const g of Object.values(by)) g.sort((a, b) => age(a) - age(b)); // the newest update first: an agent that comes back with output moves up
    let html = '';
    if (isPhoneLayout()) {
        const open = read(MORE, 'false') === 'true';
        const shownWorking = open ? by.working : by.working.slice(0, PHONE_WORKING);
        const rest = open ? [] : by.working.slice(PHONE_WORKING);
        const hidden = open ? [] : [...by.idle, ...by.done];
        for (const [key, label] of GROUPS) {
            const shown = key === 'needs' ? by.needs : key === 'working' ? shownWorking : open ? by[key] : [];
            if (!shown.length) continue;
            html += headHtml(key, label, by[key].length, false) + shown.map(s => rowHtml(s, renderRow)).join('');
        }
        const parts = [rest.length ? `${rest.length} more working` : '', !open && by.idle.length ? `${by.idle.length} idle` : '', !open && by.done.length ? `${by.done.length} done today` : ''].filter(Boolean);
        if (open) return html + `<li class="status-more"><button type="button" class="btn btn-quiet status-more-toggle" data-on-click="status-more" aria-expanded="true"><span class="status-caret open" aria-hidden="true"></span>Show fewer</button></li>`;
        if (parts.length || hidden.length) html += `<li class="status-more"><button type="button" class="btn btn-quiet status-more-toggle" data-on-click="status-more" aria-expanded="false"><span class="status-caret" aria-hidden="true"></span>${escapeHtml(parts.join(' · '))}</button></li>`;
        return html;
    }
    for (const [key, label] of GROUPS) {
        if (!by[key].length) continue;
        const folded = isFolded(key);
        html += headHtml(key, label, by[key].length, folded) + (folded ? '' : by[key].map(s => rowHtml(s, renderRow)).join(''));
    }
    return html;
}

registerActions({
    'status-fold': (el, event) => { event.stopPropagation(); const k = String(el.dataset.group || ''); if (!k) return; const m = foldedMap(); m[k] = !isFolded(k); write(FOLD, JSON.stringify(m)); redrawLiveList(); },
    // The orchestrator row (#22045): selected, it folds or opens its workers; not yet selected, it opens the agent as any row does (render.js's session-open).
    'status-orch-open': (el, event) => {
        if (el.classList.contains('active')) { event.stopPropagation(); const k = String(el.dataset.fold || ''), m = foldedMap(); m[k] = !isFolded(k); write(FOLD, JSON.stringify(m)); redrawLiveList(); return; }
        const name = textOf(el.dataset.name), type = tokenOf(el.dataset.agentType);
        if (name && type) window.selectLiveSession(name, type, textOf(el.dataset.sessionId) || '', textOf(el.dataset.server) || '', { pointer: !!event && event.detail > 0, focusChat: !!event && event.detail === 0 });
    },
    'status-more': () => { write(MORE, read(MORE, 'false') === 'true' ? 'false' : 'true'); redrawLiveList(); },
});

/** The Task box (#21685): an agent is On a task when the board's task data names it the assignee of an open task (the live row's board_task: in progress, else the oldest queued, which says "queued"). */
const hasTask = s => !!(s.board_task && s.board_task.id);
const SPLIT = [['on', 'On a task'], ['no', 'No task']];

/** A row's task line, and the "queued" tag beside its name: the shared row, with the mock's "#21685 Sidebar: Group by Task" line under the name. */
function withTaskLine(html, s) {
    if (!hasTask(s)) return html;
    const t = s.board_task, queued = t.status === 'pending';
    return html.replace('<span class="session-name-spacer"></span>', `${queued ? '<span class="status-queued">queued</span>' : ''}<span class="session-name-spacer"></span>`)
        .replace(/(\s*<\/div>\s*<div class="session-tooltip">)/, `<span class="session-task-line"><b>#${Number(t.id)}</b>${escapeHtml(String(t.title || ''))}</span>$1`); // inside the row's info column, after its last line
}
/** A subgroup's heading (On a task, No task): a caret, the name and the count, folded by hand like the Status groups. */
const subHead = (key, label, n, folded) => `<li class="status-sub" data-status="${escapeAttr(key)}"><button type="button" class="btn btn-quiet status-head-toggle" data-on-click="status-fold" data-group="${escapeAttr(key)}" aria-expanded="${escapeAttr(String(!folded))}"><span class="status-caret" aria-hidden="true"></span><span class="status-name">${escapeHtml(label)}</span><span class="session-group-count">${Number(n)}</span></button></li>`;
/** The Task box inside one scope (a team, a computer, the whole list): On a task, then No task, each with its rows. rows(list) draws agents as that scope always does.
 *  On a phone each keeps a short list: two rows of On a task and one line that counts the rest ("1 more on a task", "3 without a task"), which opens the rest. */
function taskSplit(list, scope, rows) {
    groupByStyles();
    const by = { on: list.filter(hasTask), no: list.filter(s => !hasTask(s)) };
    if (!by.on.length && !by.no.length) return '';
    const phone = isPhoneLayout(), open = !phone || !isFolded('m:' + scope);
    let html = '';
    for (const [k, label] of SPLIT) {
        if (!by[k].length) continue;
        const key = `t:${scope}:${k}`, folded = !phone && isFolded(key), shown = open ? by[k] : k === 'on' ? by[k].slice(0, PHONE_WORKING) : [];
        html += subHead(key, label, by[k].length, folded) + (folded ? '' : rows(shown).replace(/<li /g, '<li data-in="1" '));
        if (!open) { const rest = by[k].length - shown.length; if (rest) html += `<li class="status-more status-more-in"><button type="button" class="btn btn-quiet status-more-toggle" data-on-click="status-fold" data-group="${escapeAttr('m:' + scope)}" aria-expanded="false"><span class="status-caret" aria-hidden="true"></span>${Number(rest)} ${k === 'on' ? 'more on a task' : 'without a task'}</button></li>`; }
    }
    if (phone && open && list.length > PHONE_WORKING) html += `<li class="status-more status-more-in"><button type="button" class="btn btn-quiet status-more-toggle" data-on-click="status-fold" data-group="${escapeAttr('m:' + scope)}" aria-expanded="true"><span class="status-caret open" aria-hidden="true"></span>Show fewer</button></li>`;
    return html;
}

/** What the list draws when Team is not ticked: { h, a } (a: the archived ones left for the Archived section), or null when it is (render.js draws the teams, and teamList below splits each by task).
 *  wrap(agents, draw) puts a header per computer around draw's view when Computer is ticked (render.js). The view is the Status groups, or On a task / No task with the Task box. */
let arch = []; // the archived agents of the last draw (a team's "done today" row reads them)
export function lay(regular, limits, archived, renderRow, wrap) {
    arch = archived;
    mountGroupBy();
    const g = groupBy();
    if (g.server || g.team || g.task) groupByStyles(); // a grouped view is drawing: its sheet (none ticked: only the bundle's)
    if (g.team) return null;
    const sleeping = limits?.sleeping || [];
    if (limits) limits.sleeping = []; // drawn here, with the rest: render.js has none left to draw under the Team groups
    const all = [...regular, ...sleeping, ...archived.filter(doneToday)];
    const rows = list => list.map(s => withTaskLine(rowHtml(s, renderRow), s)).join('');
    const view = own => (g.task ? rows(own.filter(isOrch)) + taskSplit(own.filter(s => !isOrch(s)).sort((a, b) => age(a) - age(b)), '*', rows) : renderStatusGroups(own, renderRow)); // the Task box without Team: the orchestrators are the first rows of the list (or of their computer), above the split and in neither group
    return { h: wrap(all, view), a: archived.filter(s => !doneToday(s)) };
}

/** Draw()'s rows with each agent's task line: the markup is split per row (each starts at its <li) and the ones with a task get theirs. */
const withTaskRows = (html, list) => { const by = new Map(list.map(s => [escapeAttr(s.session_id || ''), s])); return html.split(/(?=<li )/).map(c => { const m = c.match(/data-session-id="([^"]*)"/), s = m && by.get(m[1]); return s ? withTaskLine(c, s) : c; }).join(''); };

/** The Team view's orchestrator card (the mock's "under the orchestrator"): the orchestrator's row, which opens or closes its workers when clicked while selected (#22045, was a "5 workers" button, #21686); folded, the line under it says "3 working · 1 needs you · 1 ready";
 * open, the workers follow and end with "6 done today", which opens the team's archived workers. saved: the team's agents in their saved order; draw: draws some of them as the card always did; row: draws one agent's row (an archived agent has no place in draw's lists).
 * A small team (under WORKERS_MIN workers) is drawn whole. */
const isOrch = s => /orchestrator/i.test(s.display_name || s.board_job_title || '');
export function teamList(saved, board, draw, row) {
    const task = groupBy().task, all = [...saved.filter(isOrch), ...saved.filter(s => !isOrch(s))]; // the saved order, the orchestrator pinned to the top
    const [orch, ...rest] = all, workers = rest.filter(s => !s.sleeping), asleep = rest.filter(s => s.sleeping); // sleeping ones keep the list's own "N sleeping" row
    const split = list => taskSplit(list, board, l => withTaskRows(draw(l), l)); // the Task box: the team's workers split On a task / No task
    if (task && !isOrch(orch)) return split(saved.filter(s => !s.sleeping)) + draw(saved.filter(s => s.sleeping));
    if (!task && (!isOrch(orch) || workers.length < WORKERS_MIN)) return draw(all);
    const fold = workers.length >= WORKERS_MIN; // a small team has no fold button (with the Task box its workers are split under the orchestrator all the same)
    const key = 'w:' + board, folded = task ? !!foldedMap()[key] : isFolded(key), // with the Task box the split is the point: the workers start open (the button still folds them)
         n = g => workers.filter(s => groupOf(s) === g).length;
    const sum = [`${n('working')} working`, n('needs') ? `<span class="status-shape st-needs" aria-hidden="true"></span>${Number(n('needs'))} needs you` : '', `${n('idle')} ready`].filter(x => x && !x.startsWith('0 ')).join(' · ');
    let html = (task ? withTaskRows(draw([orch]), [orch]) : draw([orch])); // the orchestrator is the team's first row, whatever the grouping (with the Task box it keeps its task line, and is in neither split group)
    if (fold) html = html.replace(/( aria-label="[^"]*)"/, `$1, ${Number(workers.length)} workers" aria-expanded="${escapeAttr(String(!folded))}"`).replace(' data-on-click="session-open"', ` data-on-click="status-orch-open" data-fold="${escapeAttr(key)}"`); // no fold button (#22045): a click (or Enter) on the row once it is selected opens or closes its workers; the first click selects it
    if (task && !(fold && folded)) return html + split(workers) + draw(asleep);
    if (folded) return html + `<li class="status-workers-sum">${sum}</li>` + draw(asleep);
    const done = arch.filter(x => x.board_project === board && doneToday(x)), dkey = 'd:' + board, dOpen = !isFolded(dkey);
    html += draw(workers);
    if (done.length) html += `<li class="status-workers-done"><button type="button" class="btn btn-quiet status-head-toggle" data-on-click="status-fold" data-group="${escapeAttr(dkey)}" aria-expanded="${escapeAttr(String(dOpen))}"><span class="status-shape st-done" aria-hidden="true"></span><span class="status-name">${Number(done.length)} done today</span></button></li>` + (dOpen ? done.map(row).join('') : '');
    return html + draw(asleep);
}

// A browser that opens with Task ticked (the one box whose rows need the sheet; Computer and Team draw with the start sheet) holds this module (so the list's first grouped draw) until the sheet is in: no unstyled first frame (#21784). With none ticked there is nothing to wait for and the start has the bundle's sheet only.
if (groupBy().task) await groupByStyles();
