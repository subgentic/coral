/* The Info dialog's Skills and Memory rows (#13209, goal #218): pure functions from the routes' answers (loaded-skills, memory, memory/{id}) to lines of text, so a skill's name or a file's text is only ever put in the page as text, and loadAgentSections, which reads the routes and fills two label/value pairs of elements. */
import { setHidden } from './dom_write.js';
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line per loaded skill: "name v2, loaded 3 times", plus ", removed" or ", newer version approved"; [] when the answer is not a list (the row stays hidden), one line saying none when nothing was loaded. */
export function skillLines(result) {
    if (!result || !Array.isArray(result.skills)) return [];
    if (!result.skills.length) return ['None loaded yet'];
    return result.skills.map(s => `${String(s.name)} v${Number(s.version) || 0}, loaded ${plural(Number(s.loads) || 0, 'time')}${s.status === 'removed' ? ', removed' : s.newer_version ? ', newer version approved' : ''}`);
}

/** One item per memory or instruction file: {id, label: "CLAUDE.md: instructions, project"}; a file with a problem has no id (it cannot be opened) and says it. [] when there is no list; one id-less item saying none when there are none. */
export function memoryItems(result) {
    if (!result || !Array.isArray(result.files)) return [];
    if (!result.files.length) return [{ id: '', label: 'None found' }];
    return result.files.map(f => {
        const label = `${String(f.file)}: ${String(f.kind)}, ${String(f.level)}`;
        return f.problem ? { id: '', label: `${label} (${String(f.problem)})` } : { id: String(f.id), label };
    });
}

/** What the pre shows for one opened file: its text, with a line when it was cut, a line instead when it is binary or could not be read, a line when it is gone. */
export function memoryText(result) {
    if (!result) return 'This file could not be read.';
    if (result.problem) return `This file cannot be shown (${String(result.problem)}).`;
    if (result.binary) return 'This file is not text.';
    return `${String(result.text ?? '')}${result.truncated ? '\n\n[cut: the file is longer than is shown]' : ''}`;
}

let memoryGen = 0; // the newest memory file asked for, over every host: an older file's answer arriving later is dropped

function fillRow(row, nodes) {
    const [label, val] = row.map(id => document.getElementById(id));
    val.replaceChildren(...nodes);
    setHidden(label, false); setHidden(val, false);
}

/** Reads what the agent loaded (loaded-skills) and its instruction and memory files (memory) and fills `rows` ({skills: [labelId, valueId], memory: [...]}); a row whose answer is missing stays as it is (hidden). `current()` says whether this look is still the newest: every await is followed by it, so an answer for an earlier look (another agent, another computer, a closed dialog) writes nothing. `server` and `sid` were captured by the caller before its first await. A click on a file marks it (aria-pressed), shows "Loading..." and owns the text block: the newest click wins whatever order the answers arrive in, and the block names the file it shows (data-file). */
export async function loadAgentSections({ name, sid, server, current, fetchJson, rows }) {
    const q = `session_id=${encodeURIComponent(sid)}`, base = `/api/sessions/live/${encodeURIComponent(name)}`;
    const [skills, memory] = await Promise.all([fetchJson(server, `${base}/loaded-skills?${q}`), fetchJson(server, `${base}/memory?${q}`)]);
    if (!current()) return;
    const lines = skillLines(skills);
    if (lines.length) fillRow(rows.skills, lines.map(l => Object.assign(document.createElement('div'), { textContent: l })));
    const items = memoryItems(memory);
    if (!items.length) return;
    const buttons = [];
    const pre = Object.assign(document.createElement('pre'), { id: 'info-memory-text', className: 'info-memory-text', hidden: true });
    const nodes = items.map(it => {
        if (!it.id) return Object.assign(document.createElement('div'), { textContent: it.label });
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'info-memory-open', textContent: it.label });
        b.setAttribute('aria-pressed', 'false');
        buttons.push(b);
        b.addEventListener('click', async () => { // listener-ok: a button this dialog makes for one file, gone when the rows are filled again
            const mine = ++memoryGen;
            for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
            pre.dataset.file = it.label; pre.textContent = 'Loading...'; setHidden(pre, false);
            const text = memoryText(await fetchJson(server, `${base}/memory/${encodeURIComponent(it.id)}?${q}`));
            if (mine === memoryGen && current()) pre.textContent = text;
        });
        return b;
    });
    fillRow(rows.memory, [...nodes, pre]);
}
