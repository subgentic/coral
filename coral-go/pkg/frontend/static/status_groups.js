/* The agent list grouped by status (#21466, the Operator's approved mock, concept mocks v3 idea 4): Needs you, Working, Idle and Done today (folded), the newest update first inside each group.
 * The group heading carries the status shape, so a row here has no dot of its own. Status is the default; Team (the orchestrator-folded view, group_cards.js) is the other choice, and the
 * choice is remembered per viewer. On a phone the list is short: every agent that needs you, two that are working, and one line that counts the rest ("2 more working · 3 idle · 6 done today").
 * Loaded when the list draws (render.js asks for it), so the first paint carries none of these bytes; its rules are in the start sheet (css/status_groups.css, last before forced-colors), paid for by the theme editor's sheet going lazy. */
import { browserLocal } from './safe_storage.js';
import { registerActions } from './actions.js';
import { redrawLiveList } from './list_hooks.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { isPhoneLayout } from './phone_layout.js';
import { sessionStateInfo } from './session_state.js';

const KEY = 'coral-agent-grouping'; // 'status' (the default) or 'team'
const FOLD = 'coral-status-folded'; // JSON: the groups the person opened or folded by hand
const MORE = 'coral-status-more'; // the phone's one line is open
const DAY = 86400;
const SHAPE = { needs: 'st-needs', working: 'st-working', idle: 'st-idle', done: 'st-done' };
const WORKERS_MIN = 4; // a team folds its workers under the orchestrator from this many
const PHONE_WORKING = 2; // working agents a phone shows before the line that counts the rest
const GROUPS = [['needs', 'Needs you'], ['working', 'Working'], ['idle', 'Idle'], ['done', 'Done today']];

const read = (k, d) => { try { return browserLocal.get(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { browserLocal.set(k, v); } catch { /* per-viewer only */ } };

/** Which grouping the list uses: status unless the person chose Team. */
export const grouping = () => (read(KEY, 'status') === 'team' ? 'team' : 'status');

const foldedMap = () => { try { return JSON.parse(read(FOLD, '{}')) || {}; } catch { return {}; } };
const isFolded = key => (key in foldedMap() ? !!foldedMap()[key] : key === 'done' || key.startsWith('w:') || key.startsWith('d:')); // Done today and a team's workers are folded until opened

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

/** The switch: Group by Team | Status. On a computer it is the list's first row; on a phone it sits in the page's own bar, beside the title Agents, as the mock has it (a row there would push the agents down). */
function switchHtml(mode) {
    const b = (v, label) => `<button type="button" class="btn" data-on-click="status-grouping" data-mode="${escapeAttr(v)}" aria-pressed="${escapeAttr(String(mode === v))}">${escapeHtml(label)}</button>`;
    const buttons = b('team', 'Team') + b('status', 'Status');
    const bar = isPhoneLayout() ? [...document.querySelectorAll('.phone-bar')].find(e => e.querySelector(':scope > .phone-bar-search-row')) : null; // the Agents page's own bar (the one with the search row)
    if (bar) {
        let seg = bar.querySelector('.status-switch-phone');
        if (!seg) { seg = document.createElement('span'); seg.className = 'btn-seg status-switch-phone'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Group agents by'); seg.innerHTML = buttons; (bar.querySelector('.phone-bar-title') || bar.firstChild).after(seg); }
        for (const x of seg.children) x.setAttribute('aria-pressed', String(x.dataset.mode === mode));
        return '';
    }
    return `<li class="status-switch"><span class="status-switch-label">Group by</span><span class="btn-seg" role="group" aria-label="Group agents by">${buttons}</span></li>`;
}

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
    let html = switchHtml('status');
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
    'status-grouping': el => { write(KEY, el.dataset.mode === 'team' ? 'team' : 'status'); redrawLiveList(); },
    'status-fold': (el, event) => { event.stopPropagation(); const k = String(el.dataset.group || ''); if (!k) return; const m = foldedMap(); m[k] = !isFolded(k); write(FOLD, JSON.stringify(m)); redrawLiveList(); },
    'status-more': () => { write(MORE, read(MORE, 'false') === 'true' ? 'false' : 'true'); redrawLiveList(); },
});

/** What the list draws in the Status view: { html, archived } (archived: the ones left for the Archived section), or null in the Team view (render.js draws that). */
let arch = []; // the archived agents of the last draw (a team's "done today" row reads them)
export function lay(regular, limits, archived, renderRow) {
    arch = archived;
    if (grouping() !== 'status') return null;
    const sleeping = limits?.sleeping || [];
    if (limits) limits.sleeping = []; // drawn here, with the rest: render.js has none left to draw under the Team groups
    return { h: renderStatusGroups([...regular, ...sleeping, ...archived.filter(doneToday)], renderRow), a: archived.filter(s => !doneToday(s)) };
}

/** The Team view's own switch: the same two buttons, drawn above the teams. */
export const sw = () => switchHtml('team');

/** The Team view's orchestrator card (the mock's "under the orchestrator"): the orchestrator's row with one "5 workers" button and a chevron at its right (#21686); folded, the line under it says "3 working · 1 needs you · 1 ready";
 * open, the workers follow and end with "6 done today", which opens the team's archived workers. saved: the team's agents in their saved order; draw: draws some of them as the card always did; row: draws one agent's row (an archived agent has no place in draw's lists).
 * A small team (under WORKERS_MIN workers) is drawn whole. */
export function teamList(saved, board, draw, row) {
    const isOrch = s => /orchestrator/i.test(s.display_name || s.board_job_title || '');
    const all = [...saved.filter(isOrch), ...saved.filter(s => !isOrch(s))]; // the saved order, the orchestrator pinned to the top
    const [orch, ...rest] = all, workers = rest.filter(s => !s.sleeping), asleep = rest.filter(s => s.sleeping); // sleeping ones keep the list's own "N sleeping" row
    if (!isOrch(orch) || workers.length < WORKERS_MIN) return draw(all);
    const key = 'w:' + board, folded = isFolded(key), n = g => workers.filter(s => groupOf(s) === g).length;
    const sum = [`${n('working')} working`, n('needs') ? `<span class="status-shape st-needs" aria-hidden="true"></span>${Number(n('needs'))} needs you` : '', `${n('idle')} ready`].filter(x => x && !x.startsWith('0 ')).join(' · ');
    const nw = Number(workers.length), toggle = `<button type="button" class="btn btn-quiet status-workers-toggle" data-on-click="status-fold" data-group="${escapeAttr(key)}" aria-expanded="${escapeAttr(String(!folded))}" aria-label="${escapeAttr((folded ? 'Show ' : 'Hide ') + nw + ' workers')}"><span class="status-workers-n">${Number(workers.length)} workers</span><span class="material-icons" aria-hidden="true">expand_more</span></button>`; // one button at the right of the row, before its menu: the name still opens the agent (#21686)
    let html = draw([orch]).replace('<span class="session-name-spacer"></span>', `<span class="session-name-spacer"></span>${toggle}`);
    if (folded) return html + `<li class="status-workers-sum">${sum}</li>` + draw(asleep);
    const done = arch.filter(x => x.board_project === board && doneToday(x)), dkey = 'd:' + board, dOpen = !isFolded(dkey);
    html += draw(workers);
    if (done.length) html += `<li class="status-workers-done"><button type="button" class="btn btn-quiet status-head-toggle" data-on-click="status-fold" data-group="${escapeAttr(dkey)}" aria-expanded="${escapeAttr(String(dOpen))}"><span class="status-shape st-done" aria-hidden="true"></span><span class="status-name">${Number(done.length)} done today</span></button></li>` + (dOpen ? done.map(row).join('') : '');
    return html + draw(asleep);
}
