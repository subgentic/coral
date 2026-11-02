/* The agent choice in New Agent's first step (#6199, Codex Test's first-run walk): a new person had to open More options > Agent to find Codex; the hidden default was Claude. The four agents are a radio group under the
 * folder, the ones this computer has first, the others marked "not installed". It is a second view of the form's own agent select (the select stays in More options, and the two follow each other), so everything that
 * reacts to that select (the missing-CLI line, the model list, the permission mode) still does. When nothing was ever chosen as the default and Claude is missing while another agent is installed, that one is selected. */
import { serverFetch, normServer, LOCAL_SERVER } from './server_base.js';
import { importOnce } from './import_once.js';
const { markOf } = await importOnce('./agent_marks.js');

const TYPES = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi'], ['opencode', 'OpenCode'], ['hermes', 'Hermes']];
const ALIAS = { gemini: 'agy', antigravity: 'agy' };
const PROBE_MS = 1500; // a CLI that is slow to answer is "unknown": it keeps its place and is not marked
const LATE_PROBE_MS = 6000; // how long the start waits for those, when Claude is missing and nothing else is known to be installed (#12169)

/** What the server says of that agent's CLI: found is true, false, or null when it could not say; why is the server's one line when the agent is not offered on its OS (Hermes on Windows, #12038). */
async function probe(server, type) {
    try {
        const r = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(type)}`);
        if (!r.ok) return { found: null };
        const d = await r.json();
        if (d.supported === false) return { found: false, why: typeof d.message === 'string' ? d.message.slice(0, 200) : 'Not offered on this computer.' };
        return { found: typeof d.found === 'boolean' ? d.found : null };
    } catch { return { found: null }; }
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
        if (markOf(type)) wrap.setAttribute('data-mark', markOf(type)); // OpenCode's and Hermes's letter (#12169)
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
    const probes = TYPES.map(([t]) => probe(server, t));
    const res = await Promise.all(probes.map(p => Promise.race([p, new Promise(r => setTimeout(() => r({ found: null }), PROBE_MS))])));
    if (group._pickToken !== token || !group.isConnected) return; // another New Agent opened meanwhile
    const found = res.map(r => r.found);
    TYPES.forEach(([type, label], i) => { // an agent this computer's OS does not offer is not a choice: no radio, no option in the select, and one line says why
        if (!res[i].why) return;
        labels.get(type).remove(); labels.delete(type);
        select.querySelector(`option[value="${type}"]`)?.remove();
        const line = document.createElement('p'); line.className = 'launch-agent-unsupported settings-hint'; line.dataset.type = type; line.textContent = res[i].why; group.append(line);
    });
    TYPES.forEach(([type], i) => {
        if (found[i] === false && labels.has(type)) { labels.get(type).querySelector('.launch-agent-missing').textContent = ' not installed'; labels.get(type).classList.add('has-mark'); }
    });
    const order = TYPES.map((_, i) => i).filter(i => labels.has(TYPES[i][0])).sort((a, b) => (found[b] === true) - (found[a] === true) || a - b); // installed first, then the rest as they were
    if (!chosen && !group.contains(document.activeElement)) for (const i of order) group.append(labels.get(TYPES[i][0])); // moving a label would drop the keyboard from it: only when nobody is on the group
    // nothing was ever chosen and the built-in default is not here: start on the first agent that is
    if (!chosen && implicitDefault && (ALIAS[select.value] || select.value) === 'claude' && found[0] === false) {
        const first = order.find(i => found[i] === true);
        if (first !== undefined) { select.value = TYPES[first][0]; select.dispatchEvent(new Event('change', { bubbles: true })); chosen = false; }
    }
    // Claude is missing and nothing was chosen, but an agent has not answered yet (the check runs "<cli> --version", which Hermes, a Python program, takes seconds to do): wait for it a while longer before giving up
    // on finding one to start on (#12169). The radios are already drawn and usable; this only moves the start, and not once a person has chosen or is on the group.
    if (!chosen && implicitDefault && (ALIAS[select.value] || select.value) === 'claude' && found[0] === false && !order.some(i => found[i] === true) && res.some(r => r.found === null)) {
        const late = await Promise.race([Promise.all(probes), new Promise(r => setTimeout(() => r(null), LATE_PROBE_MS))]);
        if (late && group._pickToken === token && group.isConnected && !chosen) {
            const first = order.find(i => late[i].found === true);
            if (first !== undefined) { select.value = TYPES[first][0]; select.dispatchEvent(new Event('change', { bubbles: true })); chosen = false; }
        }
    }
    sync();
    group.dataset.probed = '1';
    // a later check of a CLI (Check again, or after Set path and Save) draws its tile's mark again from the fresh answer, not from the one taken when the dialog opened (#10161)
    const onChecked = e => {
        if (!group.isConnected) { document.removeEventListener('cli-checked', onChecked); return; }
        const type = (ALIAS[e.detail.type] || e.detail.type), label = labels.get(type); if (!label) return;
        label.querySelector('.launch-agent-missing').textContent = e.detail.found ? '' : ' not installed';
        label.classList.toggle('has-mark', !e.detail.found);
    };
    document.addEventListener('cli-checked', onChecked);
}
