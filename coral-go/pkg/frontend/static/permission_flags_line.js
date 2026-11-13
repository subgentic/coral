/* The flags line (#15719, #15735, #15761): what Coral adds to an agent's command for the chosen permissions, and why it is not the pick's own flags, as the server's launch builders say it (POST /api/launch/permission-args: one source of truth, never a second copy here).
 * New agent's recap, Restart's settings step and Resume's mode picker all draw it from here. Lazy: loaded with the dialogs, not at start. */
import { serverFetch } from './server_base.js';
import { loadStyles } from './lazy_styles.js';
import { copyText } from './utils.js';
import { showToast } from './notifications.js';

await loadStyles('launch_recap_flags.css'); // the line's rules: not at start

export const TYPE = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', antigravity: 'Antigravity', gemini: 'Antigravity', pi: 'Pi' };
const cache = new Map(); // request body -> the answer

/** The server's answer for this body ({args, text, note}), or null when it has none (a failed call draws no line: the mode above still says it). Answers are kept by body. */
export async function fetchFlags(server, body) {
    const key = JSON.stringify(body);
    if (cache.has(key)) return cache.get(key);
    try {
        const r = await serverFetch(server, '/api/launch/permission-args', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
        if (!r.ok) return null;
        const answer = await r.json();
        if (!Array.isArray(answer.args)) return null;
        cache.set(key, answer);
        return answer;
    } catch { return null; }
}

/** The line's nodes for an answer: what is added to the command, then (when the server gives one) why it is not the pick's own. */
export function flagsNodes(answer, type) {
    if (!answer) return [];
    const line = document.createElement('span'); line.className = 'launch-recap-note launch-recap-flags';
    const text = answer.text || '';
    if (type === 'pi') line.textContent = 'Adds no permission flags: Pi has none.';
    else if (!text) line.textContent = `Adds no permission flags: ${TYPE[type] || type} starts in its own default.`;
    else { const code = document.createElement('code'); code.textContent = text; line.append('Adds ', code, ' to the command.'); }
    const nodes = [line];
    if (answer.note) { const why = document.createElement('span'); why.className = 'launch-recap-note launch-recap-flags launch-recap-why'; why.textContent = String(answer.note); nodes.push(why); }
    if (answer.command && type !== 'terminal') nodes.push(commandNode(String(answer.command)));
    else if (answer.command_error && type !== 'terminal') { const e = document.createElement('div'); e.className = 'launch-recap-note launch-recap-flags launch-recap-command-error'; e.textContent = 'Start command: could not be built. ' + String(answer.command_error); nodes.push(e); }
    return nodes;
}

/** The agent's whole start command (#15951), as the server's launch builder gives it with Coral's own values as <placeholders>: read-only, with Copy, and on a phone one line with 'Show full command'. */
export function commandNode(command) {
    const row = document.createElement('div'); row.className = 'launch-recap-note launch-recap-flags launch-recap-command';
    const label = document.createElement('span'); label.className = 'lrc-label'; label.textContent = 'Start command';
    const code = document.createElement('code'); code.className = 'lrc-text'; code.textContent = command; code.id = 'lrc-' + Math.random().toString(36).slice(2, 8);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-small lrc-copy'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy the start command');
    copy.addEventListener('click', async () => { showToast(await copyText(command) ? 'Copied the start command' : 'Could not copy the start command', false); });
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-small lrc-more'; more.textContent = 'Show full command'; more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', code.id);
    more.addEventListener('click', () => { const open = row.classList.toggle('lrc-open'); more.setAttribute('aria-expanded', String(open)); more.textContent = open ? 'Show less' : 'Show full command'; });
    const note = document.createElement('span'); note.className = 'lrc-note'; note.textContent = 'A value you type after a flag is shown as typed: keep keys and tokens out of flags.';
    row.append(label, copy, more, code, note);
    return row;
}

/** Keep `el` showing the line for whatever `getBody()` returns now (null: no line, el hidden). Call the returned function after any change in the form. A stale answer is never drawn: a later call wins. */
export function flagsLine(el, getBody, getServer) {
    let timer = 0, seq = 0;
    return function sync() {
        const body = getBody();
        const mine = ++seq;
        clearTimeout(timer);
        if (!body) { el.replaceChildren(); el.hidden = true; return; }
        timer = setTimeout(async () => {
            const answer = await fetchFlags(getServer(), body);
            if (mine !== seq) return;
            const nodes = flagsNodes(answer, body.agent_type);
            el.replaceChildren(...nodes);
            el.hidden = !nodes.length;
        }, 120);
    };
}
