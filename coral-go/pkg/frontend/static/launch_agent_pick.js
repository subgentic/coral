/* The agent choice in New Agent's first step (#6199, Codex Test's first-run walk): a new person had to open More options > Agent to find Codex; the hidden default was Claude. The four agents are a radio group under the
 * folder, the ones this computer has first, the others marked "not installed". It is a second view of the form's own agent select (the select stays in More options, and the two follow each other), so everything that
 * reacts to that select (the missing-CLI line, the model list, the permission mode) still does. When nothing was ever chosen as the default and Claude is missing while another agent is installed, that one is selected. */
import { serverFetch, normServer, LOCAL_SERVER } from './server_base.js';

const TYPES = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi']];
const ALIAS = { gemini: 'agy', antigravity: 'agy' };
const PROBE_MS = 1500; // a CLI that is slow to answer is "unknown": it keeps its place and is not marked

/** Whether the server has that agent's CLI: true, false, or null when it could not say. */
async function probe(server, type) {
    try {
        const r = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(type)}`);
        if (!r.ok) return null;
        const d = await r.json();
        return typeof d.found === 'boolean' ? d.found : null;
    } catch { return null; }
}

/** Fill `group` (the element) with the radios for the agent select of `form`. The four are drawn at once, in their usual order and usable; when the CLI probes answer (up to PROBE_MS later) the missing ones are marked, the installed ones
 *  move first and an installed agent is selected when nothing was chosen and Claude is missing: none of it while a person is on the group or has chosen (the order and the selection never move under them, #8024). group.dataset.probed says the answers are in. */
export async function buildAgentPick({ group, form, server, implicitDefault }) {
    const select = form && form.querySelector('.acf-agent-type');
    if (!group || !select) return;
    const token = (group._pickToken = (group._pickToken || 0) + 1);
    delete group.dataset.probed;
    group.querySelectorAll('.launch-agent-opt').forEach(e => e.remove()); // the "Agent:" label stays
    const note = group.id === 'launch-agent-pick' ? document.getElementById('launch-codex-note') : null; // New Agent's own group only: Restart's does not toggle its note. Codex stops on Coral's hooks question the first time (hooks_review.js, #6409): said once, here, for this computer's Codex
    const sync = () => { const v = ALIAS[select.value] || select.value; for (const r of group.querySelectorAll('input')) r.checked = r.value === v; if (note) { note.hidden = !(v === 'codex' && normServer(server) === LOCAL_SERVER); describeBy(note); } };
    const describeBy = note => { // the agent radios (the group and each choice) are described by the note while it shows: a hidden note would still be read, so the link is only there then
        const on = !note.hidden;
        for (const el of [group, ...group.querySelectorAll('input')]) { if (on) el.setAttribute('aria-describedby', note.id); else el.removeAttribute('aria-describedby'); }
    };
    let chosen = false; // a person picked an agent here, or the select moved some other way: the probes' answers leave the selection alone
    const start = select.value;
    const labels = new Map();
    for (const [type, label] of TYPES) {
        const wrap = document.createElement('label');
        wrap.className = 'launch-agent-opt';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = group.id ? `${group.id}-radios` : 'launch-agent-pick'; // one name per group: two groups in the document (New Agent's, Restart's) must not share a radio set
        input.value = type;
        input.addEventListener('change', () => { if (!input.checked) return; chosen = true; select.value = type; select.dispatchEvent(new Event('change', { bubbles: true })); });
        const name = document.createElement('span'); name.className = 'launch-agent-name'; name.textContent = label;
        const miss = document.createElement('span'); miss.className = 'launch-agent-missing'; // always there: the tile's second line is reserved, so the answer moves nothing (#8033)
        wrap.append(input, name, miss);
        group.append(wrap);
        labels.set(type, wrap);
    }
    select.addEventListener('change', () => { if (select.value !== start) chosen = true; sync(); });
    sync();
    group.hidden = false;
    form.classList.add('has-agent-pick'); // the group is the one place that names the agent: the form's own select stays (hidden by css) and follows it (#6407)
    const found = await Promise.all(TYPES.map(([t]) => Promise.race([probe(server, t), new Promise(r => setTimeout(() => r(null), PROBE_MS))])));
    if (group._pickToken !== token || !group.isConnected) return; // another New Agent opened meanwhile
    TYPES.forEach(([type], i) => {
        if (found[i] === false) { labels.get(type).querySelector('.launch-agent-missing').textContent = ' not installed'; labels.get(type).classList.add('has-mark'); }
    });
    const order = TYPES.map((_, i) => i).sort((a, b) => (found[b] === true) - (found[a] === true) || a - b); // installed first, then the rest as they were
    if (!chosen && !group.contains(document.activeElement)) for (const i of order) group.append(labels.get(TYPES[i][0])); // moving a label would drop the keyboard from it: only when nobody is on the group
    // nothing was ever chosen and the built-in default is not here: start on the first agent that is
    if (!chosen && implicitDefault && (ALIAS[select.value] || select.value) === 'claude' && found[0] === false) {
        const first = order.find(i => found[i] === true);
        if (first !== undefined) { select.value = TYPES[first][0]; select.dispatchEvent(new Event('change', { bubbles: true })); chosen = false; }
    }
    sync();
    group.dataset.probed = '1';
}
