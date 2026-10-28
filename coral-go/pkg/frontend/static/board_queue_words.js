/* What a run of the task queue's lines says, in words (#7183, UI/UX's #7180 finding 3): "4 tasks created, 1 claimed, 1 in review, 1 finished", not the lines' own command text ("run 'coral-board task claim 1'
 * to start", which is an instruction to an agent). Pure functions (node-tested). Each line is read for the task it is about and what happened to it; a task counts once per kind. No imports. */
const KINDS = [['created', 'created'], ['claimed', 'claimed'], ['review', 'in review'], ['finished', 'finished'], ['sent back', 'sent back'], ['other', 'updated']];

const bracketOf = (content) => { const text = String(content || '').replace(/^(@\S+\s+)+/, ''); const m = text.match(/\[([^\]]{1,120})\]/); return { text, bracket: m ? m[1].trim() : '' }; };

/** What happened, and to which task: { kind, id, by } for one queue line; kind is 'ignore' for the reminder that tasks are waiting (an instruction to agents, not an event). */
export function queueEvent(content) {
    const { text, bracket } = bracketOf(content);
    const s = bracket || text.split('\n')[0];
    const id = (/#(\d+)/.exec(s) || [])[1] || '';
    const by = (/\b(?:by|from)\s+([^\]]+?)\s*$/i.exec(bracket) || [])[1] || '';
    const low = s.toLowerCase();
    let kind = 'other';
    if (/claimed/.test(low)) kind = 'claimed';
    else if (/in review|review pending|for review/.test(low)) kind = 'review';
    else if (/completed|approved|finished|done\b/.test(low)) kind = 'finished';
    else if (/rejected|sent back|returned/.test(low)) kind = 'sent back';
    else if (/available|new task|^task #\d+ \(\w+\)$/.test(low) || /^task #\d+ \(\w+\)$/i.test(s)) kind = id ? 'created' : 'ignore';
    else if (!id && /tasks? (are |is )?available/.test(String(text).toLowerCase())) kind = 'ignore';
    return { kind, id, by };
}

/** The row's label for a run of lines: counts in words; one line says its own task ("Task #7 claimed by Backend Dev"). */
export function queueRunWords(contents) {
    const events = (contents || []).map(queueEvent);
    const real = events.filter(e => e.kind !== 'ignore');
    if (!real.length) return events.length ? 'Coral told the agents that tasks are waiting' : '';
    if (real.length === 1 && events.length === 1) {
        const e = real[0], verb = (KINDS.find(k => k[0] === e.kind) || [0, 'updated'])[1];
        return `${e.id ? `Task #${e.id}` : 'A task'} ${verb}${e.by && e.kind !== 'created' ? ` by ${e.by}` : ''}`;
    }
    const seen = new Map(KINDS.map(k => [k[0], new Set()]));
    real.forEach((e, i) => seen.get(e.kind).add(e.id || `line ${i}`));
    const parts = [];
    for (const [kind, verb] of KINDS) {
        const n = seen.get(kind).size; if (!n) continue;
        parts.push(parts.length ? `${n} ${verb}` : `${n} ${n === 1 ? 'task' : 'tasks'} ${verb}`);
    }
    return parts.join(', ');
}

/** One queue line for a person (#10722): what happened and to which task, with the task's title and who it is for, never the line's own instruction to an agent ("run 'coral-board task claim 1' to start"). `head` is the words before the title, so the
 *  caller can make "Task #7" a link; `rest` is what follows it. */
export function queueLineWords(content) {
    const e = queueEvent(content);
    if (e.kind === 'ignore') return { id: '', head: 'Coral told the agents that tasks are waiting', rest: '' };
    const verb = (KINDS.find(k => k[0] === e.kind) || [0, 'updated'])[1];
    const raw = String(content || ''), { text } = bracketOf(raw);
    const close = text.indexOf(']');
    const title = close < 0 ? '' : text.slice(close + 1).split(/\s[\u2014-]\s/)[0].trim().slice(0, 120);
    const who = (/^@(\S+)/.exec(raw) || [])[1];
    const forWho = e.kind === 'created' && who && who !== 'notify-all' ? ` (for ${who})` : '';
    return { id: e.id, head: e.id ? `Task #${e.id}` : 'A task', rest: ` ${verb}${e.by && e.kind !== 'created' ? ` by ${e.by}` : ''}${title ? `: ${title}` : ''}${forWho}` };
}
