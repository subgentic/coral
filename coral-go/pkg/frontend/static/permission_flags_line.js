/* The flags line (#15719, #15735, #15761): what Coral adds to an agent's command for the chosen permissions, and why it is not the pick's own flags, as the server's launch builders say it (POST /api/launch/permission-args: one source of truth, never a second copy here).
 * New agent's recap, Restart's settings step and Resume's mode picker all draw it from here. Lazy: loaded with the dialogs, not at start. */
import { serverFetch } from './server_base.js';
import { loadStyles } from './lazy_styles.js';

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
    return nodes;
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
