/* The Queue tab (#16030, the Operator's ask of 2026-11-13): the resource queue of this computer or of a linked one, in its own tab. The picker lists this computer and each connected server, as Analytics'
 * does; a linked computer's queue is read through the hub's own link (GET /api/remote/<id>/api/resources), read-only (Move and Kick stay this computer's), and a computer that does not answer keeps
 * the last queue read from it with when it was read and when it was last seen, never an empty queue. The table is the one the Automations folder had (automations_queue.js). Everything is built with
 * the DOM and textContent: agent names and notes are written by agents. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { formatLastSeen } from './server_status.js';
const AQ = await importOnce('./automations_queue.js');
const { machineChoices, machineLabel, machineOnline } = await importOnce('./analytics_machine.js');
const V = await importOnce('./analytics_viz.js');
const { el } = V;

let chosen = 'local', active = false, wired = false, drawn = '';
const body = () => document.getElementById('queue-tab-body');
const choices = () => ['local', ...machineChoices().filter(id => id !== 'local')];
const current = () => (choices().includes(chosen) ? chosen : 'local');
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
    out.push(`This is ${machineLabel(id)}'s queue, read only: move or remove an entry in that computer's own Coral.`);
    return out;
}

export function drawQueueTab() {
    const host = body(); if (!host) return;
    const id = current(); if (id !== AQ.queueMachine()) AQ.setQueueMachine(id);
    const parts = [el('h2', 'queue-tab-title', 'Resource queue')];
    if (choices().length > 1) {
        const bar = el('div', 'queue-tab-bar');
        bar.append(V.selectField('Computer', choices().map(c => [c, machineLabel(c) + (machineOnline(c) ? '' : ' (offline)')]), id, v => { chosen = v; drawQueueTab(); }));
        parts.push(bar);
    }
    for (const line of statusLines(id)) { const p = el('p', 'queue-tab-note', line); if (id !== 'local' && AQ.queueUnavailable()) p.setAttribute('role', 'status'); parts.push(p); }
    const rows = AQ.queueItems();
    const spec = AQ.queueTable(rows, false);
    // drawn again only when what is shown changed (the table's own signature, the lines, the picker): a row menu or a focused button is not taken away by a poll that found nothing new
    const sig = JSON.stringify([id, choices().map(c => [c, machineLabel(c), machineOnline(c)]), statusLines(id), spec.signature]);
    if (sig === drawn && host.firstChild) return;
    if (document.querySelector('#queue-tab-body .dt-mail-menu:not([hidden])')) return; // a phone's row menu is open: the next change draws it
    const wrap = el('div', 'queue-tab-table'); wrap.dataset.machine = id; wrap.append(spec.node());
    parts.push(wrap);
    // a table drawn again under a Kick waiting for its second press would take the press away: keep the one on screen
    if (document.querySelector('#queue-tab-body .queue-sure')) return;
    drawn = sig;
    host.replaceChildren(...parts);
}

export function showQueueTab() {
    active = true;
    const host = document.getElementById('queue-view'); if (!host) return;
    if (!body()) { const b = el('div', 'queue-tab-body'); b.id = 'queue-tab-body'; host.append(b); }
    if (!wired) { wired = true; AQ.onQueueChanged(() => { if (active) drawQueueTab(); }); document.addEventListener('coral:servers-updated', () => { if (active) drawQueueTab(); }); }
    AQ.watchQueue(true);
    drawQueueTab();
}
export function leaveQueueTab() { active = false; AQ.watchQueue(false); }
