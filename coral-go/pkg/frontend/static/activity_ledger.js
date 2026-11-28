/* The Activity folder's list as a decision ledger (#19816, the Inbox Designer's mocks v1): one row per action, a kind tile, the subject with what you did as a coloured verdict, your answer or note quoted under it, who asked and the goal and task as chips,
 * team and time at the right with the way to open it. Rows come under date headers (Today, Yesterday, a day), or under a goal and a task heading when grouped. Pure drawing: the folder (inbox_activity.js) owns the rows, the words and how an item opens.
 * Every string shown is text (textContent): titles, notes and names are words an agent wrote. */
import { importOnce } from './import_once.js';
import { escapeAttr } from './html_escape.js';
import { timeCell } from './data_table.js';
const { decisionOf } = await importOnce('./operator_activity_filters.js');
const { fileKindOf } = await importOnce('./file_kind.js');
const { artifactThumbnail, thumbnailPath } = await importOnce('./artifact_thumbnail.js');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
/** The kind a row's tile shows: the item it was about, a permission or a skill by its action. */
export const tileKind = r => /^(prompt_allow|prompt_reject|wait_)/.test(r.action || '') ? 'permission' : /^skill_/.test(r.action || '') ? 'skill' : /\.(png|jpe?g|webp|gif)$/i.test(r.title || '') && r.item_kind === 'file' ? 'image' : r.item_kind;
/** The verdict's colour: what you did, as the record says it. */
export const verdictOf = r => { const d = decisionOf(r); return ({ approve: 'approve', changes: 'changes', deny: 'deny', answer: 'answer', dismiss: 'neutral' })[d] || (['goal_close', 'task_complete'].includes(r.action) ? 'approve' : ['goal_review', 'proposal'].includes(r.action) ? 'purple' : 'neutral'); };

const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** The date header's words for a row's time: Today, Yesterday, else the weekday and day. */
export function dayWords(at, now = Date.now()) {
    const t = Date.parse(at); if (!Number.isFinite(t)) return 'Earlier';
    const days = Math.round((midnight(now) - midnight(t)) / 864e5);
    return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

/** A file's versions as a popover: the server's list (the team's series, from the upload records) when the row has one, else the versions the records in the list name (same file name and team). Each says what was done to it when a record
 * in the list holds that digest, else whether it is the newest; Open opens that version. */
const fileKey = r => `${r.server || ''}|${r.team || ''}|${r.title || ''}`;
function versionsList(r, x) {
    const known = (x.versions && x.versions.get(fileKey(r))) || [];
    const said = new Map(known.map(v => [String(v.version || v.item_id), v]));
    let all;
    if (Array.isArray(r.file_versions) && r.file_versions.length) all = r.file_versions.map(v => ({ n: v.n, at: v.at, digest: v.digest, row: said.get(v.digest) || { ...r, item_id: v.digest, version: v.digest } }));
    else all = known.map((v, i) => ({ n: i + 1, at: v.at, digest: String(v.version || v.item_id), row: v }));
    return r.item_kind !== 'file' || all.length < 2 ? [] : all;
}
function versionsOf(r, x) {
    const mine = String(r.version || r.item_id || '');
    const known = (x.versions && x.versions.get(fileKey(r))) || [];
    const said = new Map(known.map(v => [String(v.version || v.item_id), v]));
    const all = versionsList(r, x);
    if (!all.length) return null;
    const latest = all[all.length - 1].digest;
    const d = el('details', 'al-versions'), sum = el('summary', 'btn btn-small btn-quiet', `Versions (${all.length})`), pop = el('div', 'al-pop'); pop.setAttribute('role', 'group'); pop.setAttribute('aria-label', 'Document versions');
    for (const v of [...all].reverse()) { // newest first, as the mock lists them
        const row = el('div', 'al-pop-row'), has = said.get(v.digest);
        const state = v.digest === latest ? (has ? `Latest \u00b7 ${x.parts(has).did}` : 'Latest') : has ? x.parts(has).did : v.digest === mine ? 'Reviewed here' : 'Earlier';
        row.append(el('span', 'al-pop-name', `v${v.n}`), el('span', 'al-pop-state', state));
        if (v.at) row.append(timeCell(v.at));
        const ob = el('button', 'btn btn-small', 'Open'); ob.type = 'button'; ob.setAttribute('aria-label', `Open v${v.n} of ${r.title || 'the file'}`); ob.addEventListener('click', () => { d.open = false; x.openRow(v.row); }); row.append(ob); pop.append(row);
    }
    d.addEventListener('keydown', e => { if (e.key === 'Escape') { d.open = false; sum.focus(); } });
    d.append(sum, pop);
    return d;
}

/** The row's More menu: the extra things to do with a record, as the caller lists them (`x.moreFor(r)` -> [{label, run}]); none, no menu. */
function moreMenu(r, x) {
    const items = x.moreFor ? x.moreFor(r) : [];
    if (!items.length) return null;
    const d = el('details', 'al-more'), sum = el('summary', 'btn btn-small btn-quiet', 'More \u25be'), pop = el('div', 'al-pop'); pop.setAttribute('role', 'menu'); sum.setAttribute('aria-label', `More for ${x.openLabel(r)}`);
    for (const it of items) { const b = el('button', 'btn btn-small al-menu-item', it.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.addEventListener('click', () => { d.open = false; it.run(); }); pop.append(b); }
    d.addEventListener('keydown', e => { if (e.key === 'Escape') { d.open = false; sum.focus(); } });
    d.append(sum, pop);
    return d;
}

/* The row's kind mark (the approved mock, #22100): a quiet 16 px grey drawing, one per kind. Constant markup, no record words in it. */
const G = (body, label) => `<svg class="al-kind" viewBox="0 0 16 16" role="img" aria-label="${escapeAttr(label)}"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`;
const PAGE = 'M4 1.75h5.5L12.5 4.75v9.5h-8.5z M9.25 1.75v3.25h3.25';
const KIND_SVG = {
    html: G(`<path d="${PAGE}"/><path d="M7.2 8.4 5.9 10l1.3 1.6M9.3 8.4l1.3 1.6-1.3 1.6"/>`, 'Web page'),
    text: G(`<path d="${PAGE}"/><path d="M6 8h4.5M6 10h4.5M6 12h3"/>`, 'Text document'),
    image: G('<rect x="2.25" y="3" width="11.5" height="10" rx="1.5"/><circle cx="5.6" cy="6.3" r="1"/><path d="M2.6 11.6 6 8.6l2.4 2 2-1.7 3 2.6"/>', 'Image'),
    question: `<svg class="al-kind" viewBox="0 0 16 16" role="img" aria-label="Question"><g transform="rotate(-14 8 9)" fill="currentColor"><rect x="4.1" y="3" width="1.9" height="6.5" rx=".95"/><rect x="6.2" y="1.7" width="1.9" height="7.5" rx=".95"/><rect x="8.3" y="2.2" width="1.9" height="7" rx=".95"/><rect x="10.4" y="3.6" width="1.9" height="6" rx=".95"/><path d="M4.1 7.6h8.2v2.6a4.1 4.1 0 0 1-4.1 4.1h-.5a4.1 4.1 0 0 1-3.4-1.8L2 9.6a1 1 0 0 1 1.6-1.2l.5.6z"/></g></svg>`,
    permission: '<svg class="al-kind" viewBox="0 0 16 16" role="img" aria-label="Permission"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    goal: G('<path d="M3 1.75v12.5M3 2.75h9l-2 3 2 3H3"/>', 'Goal'),
    task: G('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.5 8.2 1.8 1.8 3.4-3.6"/>', 'Task'),
    other: G('<circle cx="8" cy="8" r="5.5"/><path d="M8 7.2v3.6M8 5.3v.1"/>', 'Action'),
};
const FLAG = '<svg class="al-gflag" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5v13M3 2.5h9l-2 3 2 3H3" fill="currentColor" fill-opacity=".9" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const svgNode = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstChild; };
/** Which drawing a row gets: a file by what it is (a page, a picture, text), else its kind. */
export const kindMark = r => { const k = tileKind(r), fk = k === 'file' || k === 'image' ? fileKindOf(r.title) : null; return fk ? (fk.kind === 'html' ? 'html' : fk.kind === 'image' ? 'image' : 'text') : Object.hasOwn(KIND_SVG, k) ? k : 'other'; };
const MARK = { approve: '✓ ', changes: '↩ ', deny: '✕ ', answer: '' };
const VCLASS = { approve: 'ok', changes: 'ch', deny: 'no', answer: 'an', neutral: 'dm', purple: 'goal' };
/** One clock time ("9:44 PM"): the day is the heading's, the exact stamp is the hover (#22100). */
export const clockTime = at => { const t = new Date(at); const s = el('time', 'al-when', Number.isFinite(t.getTime()) ? t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''); if (Number.isFinite(t.getTime())) { s.title = t.toLocaleString(); s.dateTime = t.toISOString(); } return s; };
const link = (cls, text, run, label) => { const b = el('button', `al-link ${cls || ''}`, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', e => { e.stopPropagation(); run(); }); return b; };

/** One row. `x`: { parts(r) -> { did, on, detail, about }, opens(r), openRow(r), openLabel(r), teamWords(r), teamNode?(r, words), fromWords(r), keyOf(r), openGoal?(r), openTask?(r) }. The approved Activity mock: a kind mark, the name, one line of what you did and where, the clock time at the right; the buttons show on hover or focus, and a phone has one menu. */
export function ledgerRow(r, x) {
    const perm = r.action === 'prompt_allow' || r.action === 'prompt_reject', p0 = x.parts(r);
    const p = perm ? { ...p0, did: r.action === 'prompt_reject' ? 'Denied' : 'Allowed', on: `${(x.agentName && x.agentName(r)) || r.item_id || 'An agent'} asked for permission`, detail: '' } : p0; // the mock and Needs you say Denied; the record keeps no command yet (task #22144), so the title names the agent
    const v = verdictOf(r), open = x.opens(r), kind = tileKind(r);
    const li = el('li', `al-row${r.action === 'wait_send' ? ' is-noise' : ''}`); li.dataset.key = x.keyOf(r); li.dataset.kind = kind || 'other';
    const lead = el('span', `al-lead al-lead-${kind || 'other'}`); lead.append(svgNode(KIND_SVG[kindMark(r)] || KIND_SVG.other));
    if (kind === 'goal') lead.classList.add('al-lead-goal');
    const main = el('div', 'al-main'), head = el('div', 'al-head');
    const title = open ? el('button', 'al-title', p.on) : el('span', 'al-title al-title-plain', p.on);
    if (open) { title.type = 'button'; title.setAttribute('aria-label', `${p.on}. ${p.about ? `${p.about}. ` : ''}Open ${x.openLabel(r)}`); title.addEventListener('click', () => x.openRow(r)); } // the decision with its comments and versions (the viewer is in it)
    head.append(title);
    if (r.file_n) head.append(el('span', 'al-ver', r.file_latest_n > r.file_n ? `version ${r.file_n} of ${r.file_latest_n}` : `version ${r.file_n}`)); // grey, once: the version this row acted on
    main.append(head);
    if (r.ask) title.title = r.ask; // the question the file was sent with: the mock's row has no line for it, so it is the name's tip
    const said = String(p.detail || '').replace(/^from [^·]+(?: · |$)/, '').replace(/^Your answer: /, ''), asker = r.item_kind === 'question' && x.fromWords(r) ? x.fromWords(r).replace(/^from /, 'to ') : '';
    const sub = el('div', 'al-sub'), parts = [];
    const verb = el('span', `al-v al-v-${VCLASS[v] || 'dm'}`, `${MARK[v] || ''}${p.did}`);
    const first = el('span', 'al-seg'); first.append(verb);
    if (r.item_kind === 'question' && said) { first.append(document.createTextNode(` “${said}”${asker ? ' to ' : ''}`)); if (asker) { const who = asker.replace(/^to /, ''), w = link('al-who', who, () => x.openAgent && x.openAgent(who), `Open ${who}`); if (!x.openAgent) w.disabled = true; first.append(w); } } // the agent answered, a bold link, as the mock draws it
    const label = perm ? String(r.note || '').trim() : '';
    if (label && !/^(yes|no)(,? once)?\.?$/i.test(label)) first.append(document.createTextNode(` (${label})`)); // "Yes, and don't ask again" says more than the verb; a bare Yes or No does not
    parts.push(first);
    if (r.goal_id && !x.hideGoal && !(r.item_kind === 'goal' && String(r.item_id) === String(r.goal_id))) { const g = el('span', 'al-seg'); const gl = link('al-glink', `#${r.goal_id}${r.goal_title ? ` ${r.goal_title}` : ''}`, () => x.openGoal && x.openGoal(r), `Goal #${r.goal_id}${r.goal_title ? `: ${r.goal_title}` : ''}`); gl.prepend(svgNode(FLAG)); if (!x.openGoal) gl.disabled = true; g.append(gl); parts.push(g); }
    if (r.task_id && !x.hideTask && !(r.item_kind === 'task' && String(r.item_id) === String(r.task_id))) { const t = el('span', 'al-seg'), tl = link('', `task #${r.task_id}${r.task_title ? ` ${r.task_title}` : ''}`, () => x.openTask && x.openTask(r), `Task #${r.task_id}${r.task_title ? `: ${r.task_title}` : ''}`); if (!x.openTask) tl.disabled = true; t.append(tl); parts.push(t); }
    const team = x.teamWords(r);
    if (team) { const t = el('span', 'al-seg al-team'); t.append(x.teamNode ? x.teamNode(r, team) : document.createTextNode(team)); parts.push(t); }
    if (r.source === 'hub') parts.push(el('span', 'al-seg', 'via Coral Hub'));
    parts.forEach((seg, i) => { if (i < parts.length - 1) glueDot(seg); sub.append(seg); if (i < parts.length - 1) sub.append(' '); }); // one run of words: a line may break after a dot, never before one
    sub.append(el('span', 'al-sr', `. You did this from ${x.doneFrom(r)}.`)); // who and where, for a screen reader: the mock shows neither
    main.append(sub);
    if (perm) { if (r.command) main.append(el('div', 'al-cmd', String(r.command))); } // the command, once the record keeps it (task #22144)
    else if (said && r.item_kind !== 'question') { // the person's own words: a plain box, as an agent's words are in Needs you
        const note = el('div', 'al-ynote'); note.append(el('span', '', r.item_kind === 'file' ? 'Your note:' : 'Note:'), document.createTextNode(` ${said}`)); main.append(note);
    }
    const side = el('div', 'al-side'), acts = el('div', 'al-hov');
    const vs = open ? versionsOf(r, x) : null, more = moreMenu(r, x);
    if (vs) acts.append(vs);
    if (more) acts.append(more);
    if (acts.childElementCount) side.append(acts);
    side.append(clockTime(r.at));
    if (open || acts.childElementCount) side.append(phoneMenu(r, x, vs, more, open)); // under the time on a phone, on every row that can be opened or has actions, as the mock draws it
    li.append(lead, main, side);
    return li;
}

/** The "·" after a segment, held to its last word or link so a line never starts with a dot or leaves one alone: a link is an atomic box, so it and the dot share a no-wrap span. */
function glueDot(seg) {
    const last = seg.lastChild, dot = el('span', 'al-sep', '·');
    if (last && last.nodeType === 3) { last.textContent += '\u00a0'; seg.append(dot); return; }
    const nw = el('span', 'al-nw'); if (last) nw.append(last); nw.append('\u00a0', dot); seg.append(nw);
}

/** A phone has no hover: one 44 px menu holds what the buttons hold (the versions to open, then the row's More actions). */
function phoneMenu(r, x, hasVersions, hasMore, opens) {
    const items = [];
    if (hasVersions) { const vers = versionsList(r, x); for (const v of [...vers].reverse()) items.push({ label: `Open version ${v.n}`, run: () => x.openRow(v.row) }); }
    else if (opens) items.push({ label: 'Open', run: () => x.openRow(r) });
    if (hasMore) items.push(...x.moreFor(r));
    const d = el('details', 'al-dots'), sum = el('summary', null, '⋯'), pop = el('div', 'al-pop'); pop.setAttribute('role', 'menu'); sum.setAttribute('aria-label', `Actions for ${x.openLabel(r)}`);
    for (const it of items) { const b = el('button', 'btn btn-small al-menu-item', it.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.addEventListener('click', () => { d.open = false; it.run(); }); pop.append(b); }
    d.addEventListener('keydown', e => { if (e.key === 'Escape') { d.open = false; sum.focus(); } });
    d.append(sum, pop);
    return d;
}

/** A group heading: a goal's or a task's. A task's (`g.onToggle`) is one button that opens and shuts its rows, with a Story button beside it when the task has one; a story shows as its own row under the heading. */
function groupHead(g) {
    const [first, second] = String(g.label || '').split('\n');
    const h = el('li', `al-group-head${g.level === 'task' ? ' al-subgroup-head' : ''}`), words = el('span', 'al-group-words');
    words.append(el('span', 'al-group-title', first)); if (second) words.append(el('span', 'al-group-meta', second));
    if (!g.onToggle) { h.append(words); return [h]; }
    const b = el('button', 'al-group-toggle'); b.type = 'button'; b.setAttribute('aria-expanded', String(g.open !== false)); b.dataset.groupKey = g.key; b.append(words); b.addEventListener('click', g.onToggle); h.append(b);
    if (g.onStory) { const sb = el('button', 'btn btn-small btn-quiet al-group-story', 'Story'); sb.type = 'button'; sb.setAttribute('aria-pressed', String(!!g.storyOpen)); sb.setAttribute('aria-label', `Story of ${first}`); sb.dataset.groupKey = g.key; sb.addEventListener('click', g.onStory); h.append(sb); }
    const out = [h];
    if (g.story && g.storyOpen) { const sr = el('li', 'al-story-row'); sr.append(g.story()); out.push(sr); }
    return out;
}

/** The ledger: rows under date headers (newest or oldest first as given), or under `groupFor(row)` headings when grouped; a shut group shows its heading only. */
export function ledger(rows, x, { groupFor = null, now = Date.now() } = {}) {
    const versions = new Map();
    for (const r of [...rows].sort((p, q) => Date.parse(p.at) - Date.parse(q.at))) if (r.item_kind === 'file' && (r.version || r.item_id)) { const k = fileKey(r), list = versions.get(k) || []; if (!list.some(v => (v.version || v.item_id) === (r.version || r.item_id))) list.push(r); versions.set(k, list); }
    x = { ...x, versions };
    if (!groupFor) { // days: a heading with its count above its own box of rows (the approved mock, #22100)
        const box = el('div', 'al-days'), counts = new Map();
        for (const r of rows) { const h = dayWords(r.at, now); counts.set(h, (counts.get(h) || 0) + 1); }
        let list = null, last = null;
        for (const r of rows) {
            const head = dayWords(r.at, now);
            if (head !== last) { last = head; const h = el('h3', 'al-date-head'); h.append(el('span', '', head), el('span', 'al-day-count', String(counts.get(head)))); list = el('ul', 'al-list'); list.setAttribute('aria-label', `${x.label || 'Activity'}, ${head}`); box.append(h, list); }
            list.append(ledgerRow(r, x));
        }
        return box;
    }
    const ul = el('ul', 'al-list'); ul.setAttribute('aria-label', x.label || 'Activity');
    let lastHead = null, lastParent = null;
    for (const r of rows) {
        if (groupFor) {
            const g = groupFor(r);
            if (g && g.key !== lastHead) {
                lastHead = g.key;
                if (g.parent) { if (g.parent.key !== lastParent) { lastParent = g.parent.key; ul.append(...groupHead(g.parent)); } } else lastParent = g.key;
                ul.append(...groupHead(g));
            }
            if (g && g.open === false) continue;
        }
        ul.append(ledgerRow(r, x));
    }
    return ul;
}
