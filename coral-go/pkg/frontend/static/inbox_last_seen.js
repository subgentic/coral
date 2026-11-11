/* Last-known Needs you rows of a computer that went offline (#15380, C). A Hub's Needs you drops a computer's items the moment it stops answering; this keeps what each computer last showed, in this
 * page's memory only (never written to any storage, #15380 Security), and lists it read-only under the table: marked "offline, last seen HH:MM", with no action, and not in any count (the badge, the
 * sidebar and the page header read needsCount(), which never sees these). It is dropped when the person signs out and when a computer is removed. A lazy module: nothing of it loads at start. */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }; // text only, never markup

const MAX_PER_COMPUTER = 50, LINE_MAX = 140;
const kept = new Map(); // computer id -> { at, label, rows: [{ kind, line }] }

const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = s => { const c = clean(s); return c.length > LINE_MAX ? `${c.slice(0, LINE_MAX - 1)}…` : c; };
const kindOf = s => s.operatorAsk ? 'Question' : s.proposal ? 'Proposal' : s.review ? 'File' : s.goalDone ? 'Goal' : s.skillReview ? 'Skill' : s.autorun ? 'Run' : 'Agent';

/** Remember what each ONLINE computer shows now. rows are the Needs you rows (each tagged with its computer by sessionServer); lineOf says one row in words. */
export function remember(servers, rows, sessionServer, lineOf, now = Date.now()) {
    for (const s of servers) {
        if (!s || !s.id || s.id === 'local' || s.status !== 'online') continue;
        const mine = rows.filter(r => !r.welcome && sessionServer(r) === s.id).slice(0, MAX_PER_COMPUTER);
        kept.set(s.id, { at: now, label: clean(s.label || s.id), rows: mine.map(r => ({ kind: kindOf(r), line: cut(lineOf(r)) })) });
    }
    for (const id of [...kept.keys()]) if (!servers.some(s => s && s.id === id)) kept.delete(id); // a computer that was removed is forgotten
}

/** What is kept for the computers that are registered and not online now (and had something). */
export function offline(servers) {
    return servers.filter(s => s && s.id && s.status !== 'online' && kept.has(s.id) && kept.get(s.id).rows.length).map(s => ({ id: s.id, ...kept.get(s.id) }));
}

const clock = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** "2 on Lab (offline, last seen 12:04)". */
export const words = e => `${e.rows.length} on ${e.label} (offline, last seen ${clock(e.at)})`;

/** A short text for a table's signature: it changes when what is listed does. */
export const signature = servers => offline(servers).map(e => [e.id, e.at, e.rows.length]);

/** The read-only block: one heading per computer and its lines, all as text. */
export function node(servers) {
    const list = offline(servers);
    if (!list.length) return null;
    const wrap = el('div', 'inbox-last-seen');
    wrap.setAttribute('aria-label', 'Last seen on offline computers: not counted, no actions');
    for (const e of list) {
        wrap.append(el('strong', 'inbox-last-seen-head', words(e)));
        for (const r of e.rows) wrap.append(el('div', 'inbox-last-seen-row', `${r.kind}: ${r.line}`));
    }
    return wrap;
}

/** Drop everything kept (sign-out). */
export function forget() { kept.clear(); }
document.addEventListener('coral:signed-out', forget);
