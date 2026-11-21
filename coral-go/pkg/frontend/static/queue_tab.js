/* The Queue tab (#16030, the Operator's ask of 2026-11-13): the resource queue of this computer or of a linked one, in its own tab. The picker lists this computer and each connected server, as Analytics'
 * does; a linked computer's queue is read through the hub's own link (GET /api/remote/<id>/api/resources), read-only (Move and Kick stay this computer's), and a computer that does not answer keeps
 * the last queue read from it with when it was read and when it was last seen, never an empty queue. The table is the one the Automations folder had (automations_queue.js). Everything is built with
 * the DOM and textContent: agent names and notes are written by agents. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { formatLastSeen } from './server_status.js';
import { loadStyles } from './lazy_styles.js';
import { isCloud } from './server_base.js';
import { isPhoneLayout } from './phone_layout.js';
const VL = await importOnce('./view_list.js'); // the left navbar: the same list Automations, Skills and the Inbox draw (#18719)
const AQ = await importOnce('./automations_queue.js');
const { machineChoices, machineLabel, machineOnline } = await importOnce('./analytics_machine.js');
const V = await importOnce('./analytics_viz.js');
await loadStyles('queue_tab.css'); // the page's rules load with the tab, not at start (#18093: it had none)
const { el } = V;

let chosen = 'local', active = false, wired = false, drawn = '', query = '', sideNav = null;
const body = () => document.getElementById('queue-tab-body');
const choices = () => (isCloud() ? machineChoices().filter(id => id !== 'local') : ['local', ...machineChoices().filter(id => id !== 'local')]); // in the Hub there is no "This computer": only the linked ones (#19568)
const current = () => (choices().includes(chosen) ? chosen : (choices()[0] || 'local'));
const ageWords = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? 'just now' : formatLastSeen(new Date(at).toISOString()); };

/** The line under the picker for a linked computer: read-only, and what is known when it does not answer. */
function statusLines(id) {
    if (id === 'local') return [];
    const out = [];
    const server = (state.servers || []).find(s => s && s.id === id) || {};
    const bad = AQ.queueUnavailable();
    if (bad) {
        out.push(`${machineLabel(id)}: ${bad}`);
        if (server.last_seen) out.push(`Last seen ${formatLastSeen(server.last_seen)}.`);
        if (AQ.queueLoaded() && AQ.queueReadAt()) out.push(`The queue shown is the last one read, ${ageWords(AQ.queueReadAt())}.`);
    } else if (!machineOnline(id)) {
        out.push(`${machineLabel(id)} is offline${server.last_seen ? `, last seen ${formatLastSeen(server.last_seen)}` : ''}.`);
        if (AQ.queueLoaded() && AQ.queueReadAt()) out.push(`The queue shown is the last one read, ${ageWords(AQ.queueReadAt())}.`);
    }
    out.push(`This is ${!id || id === 'local' ? 'this computer' : machineLabel(id)}'s queue, read only: move or remove an entry in that computer's own Coral.`);
    return out;
}

/** The navbar is a list that grows: one entry now (Resources, this view); another kind of queue is one more item. */
const QUEUES = [{ key: 'resources', label: 'Resources', icon: 'queue' }];
const matches = r => !query || [r.agent, r.resource, r.note, r.project, r.goal_title, r.member, r.task ? `#${r.task}` : '', r.state === 'free' ? 'free' : r.state].join(' ').toLowerCase().includes(query);
const navSpec = rows => ({ sections: [{ title: 'Queue', items: QUEUES.map(q => ({ ...q, count: rows.filter(r => r.state !== 'free').length })) }], current: 'resources' });
function drawNav(rows) {
    const list = document.getElementById('queue-nav-list'); if (!list) return;
    const spec = navSpec(rows);
    if (sideNav && list.contains(sideNav)) VL.update(sideNav, spec);
    else { sideNav = VL.build({ id: 'queue-views', label: 'Queue views', ...spec, onPick: () => {} }); list.replaceChildren(sideNav); }
    importOnce('./sidebar_folder_rail.js').then(m => m.drawFolderRail('queue', 'Queue', spec.sections[0].items, spec.current, () => {})).catch(() => {}); // the collapsed rail's icons
}
const emptyState = (line, hint) => { const box = el('div', 'empty-state'); box.setAttribute('role', 'status'); box.append(el('p', 'empty-state-line', line)); if (hint) box.append(el('p', 'empty-state-hint', hint)); return box; };
const NOTHING = ['Nothing is waiting for a computer', 'When an agent needs a shared computer, it lines up here: who holds it, who waits, and for how long. An Orchestrator defines a resource with coral-board resource.'];

export function drawQueueTab() {
    const host = body(); if (!host) return;
    const id = current(); if (id !== AQ.queueMachine()) AQ.setQueueMachine(id);
    const parts = [];
    if (isPhoneLayout()) parts.push(VL.build({ id: 'queue-views-page', label: 'Queue views', ...navSpec(AQ.queueItems()), onPick: () => {}, tabs: true })); // a phone has no sidebar: the views are a strip at the top of the page, which names the view
    else parts.push(el('h2', 'queue-tab-title', 'Resources'));
    if (choices().length > 1) {
        const bar = el('div', 'queue-tab-bar');
        bar.append(V.selectField('Computer', choices().map(c => [c, machineLabel(c) + (machineOnline(c) ? '' : ' (offline)')]), id, v => { chosen = v; drawQueueTab(); }));
        parts.push(bar);
    }
    for (const line of statusLines(id)) { const p = el('p', 'queue-tab-note', line); if (id !== 'local' && AQ.queueUnavailable()) p.setAttribute('role', 'status'); parts.push(p); }
    const all = AQ.queueItems(), rows = all.filter(matches);
    const spec = AQ.queueTable(rows, !!query);
    // drawn again only when what is shown changed (the table's own signature, the lines, the picker): a row menu or a focused button is not taken away by a poll that found nothing new
    const sig = JSON.stringify([id, choices().map(c => [c, machineLabel(c), machineOnline(c)]), statusLines(id), spec.signature, query, isPhoneLayout(), all.filter(r => r.state !== 'free').length]);
    if (sig === drawn && host.firstChild) return;
    if (document.querySelector('#queue-tab-body .dt-mail-menu:not([hidden])')) return; // a phone's row menu is open: the next change draws it
    if (!rows.length && !AQ.queueUnavailable()) parts.push(emptyState(...(!all.length && AQ.queueLoaded() ? NOTHING : [spec.empty.line, spec.empty.hint]))); // no entry: the page says why (a search that matches none, a queue not read yet, nothing defined)
    else { const wrap = el('div', 'queue-tab-table'); wrap.dataset.machine = id; wrap.append(spec.node()); parts.push(wrap); }
    // a table drawn again under a Kick waiting for its second press would take the press away: keep the one on screen
    if (document.querySelector('#queue-tab-body .queue-sure')) return;
    drawn = sig;
    host.replaceChildren(...parts);
    drawNav(all);
}

export function showQueueTab() {
    active = true;
    const host = document.getElementById('queue-view'); if (!host) return;
    if (!body()) { const b = el('div', 'queue-tab-body'); b.id = 'queue-tab-body'; host.append(b); }
    if (!wired) { wired = true; AQ.onQueueChanged(() => { if (active) drawQueueTab(); }); document.addEventListener('coral:servers-updated', () => { if (active) drawQueueTab(); }); }
    const box = document.getElementById('queue-search');
    if (box && !box.dataset.wired) { box.dataset.wired = '1'; box.addEventListener('input', () => { query = box.value.trim().toLowerCase(); drawQueueTab(); }); } // the sidebar's search box: the page loads with the tab
    AQ.watchQueue(true);
    drawQueueTab();
}
export function leaveQueueTab() { active = false; AQ.watchQueue(false); }
