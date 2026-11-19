/* The Activity folder's list as a decision ledger (#19816, the Inbox Designer's mocks v1): one row per action, a kind tile, the subject with what you did as a coloured verdict, your answer or note quoted under it, who asked and the goal and task as chips,
 * team and time at the right with the way to open it. Rows come under date headers (Today, Yesterday, a day), or under a goal and a task heading when grouped. Pure drawing: the folder (inbox_activity.js) owns the rows, the words and how an item opens.
 * Every string shown is text (textContent): titles, notes and names are words an agent wrote. */
import { importOnce } from './import_once.js';
import { timeCell } from './data_table.js';
const { decisionOf } = await importOnce('./operator_activity_filters.js');
const { fileKindOf } = await importOnce('./file_kind.js');
const { artifactThumbnail, thumbnailPath } = await importOnce('./artifact_thumbnail.js');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const TILE = { file: 'description', question: 'help_outline', goal: 'flag', task: 'task_alt', proposal: 'checklist', skill: 'auto_awesome', run: 'error_outline', job_run: 'error_outline', workflow_run: 'error_outline', permission: 'lock' };
/** What the open button says: the kind it opens, short, so a long title never stretches the row (the title is in its name). */
const OPEN_WORD = { file: 'Open file', question: 'View thread', goal: 'Open goal', task: 'Open task', agent: 'Open agent', message: 'Open message', chat: 'Open chat', workflow_run: 'Open run', job_run: 'Open run' };
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
function versionsOf(r, x) {
    const mine = String(r.version || r.item_id || '');
    const known = (x.versions && x.versions.get(fileKey(r))) || [];
    const said = new Map(known.map(v => [String(v.version || v.item_id), v]));
    let all;
    if (Array.isArray(r.file_versions) && r.file_versions.length) all = r.file_versions.map(v => ({ n: v.n, at: v.at, digest: v.digest, row: said.get(v.digest) || { ...r, item_id: v.digest, version: v.digest } }));
    else all = known.map((v, i) => ({ n: i + 1, at: v.at, digest: String(v.version || v.item_id), row: v }));
    if (r.item_kind !== 'file' || all.length < 2) return null;
    const latest = all[all.length - 1].digest;
    const d = el('details', 'al-versions'), sum = el('summary', 'btn btn-small', `Versions (${all.length})`), pop = el('div', 'al-pop'); pop.setAttribute('role', 'group'); pop.setAttribute('aria-label', 'Document versions');
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
    const d = el('details', 'al-more'), sum = el('summary', 'btn btn-small btn-quiet', 'More'), pop = el('div', 'al-pop'); pop.setAttribute('role', 'menu'); sum.setAttribute('aria-label', `More for ${x.openLabel(r)}`);
    for (const it of items) { const b = el('button', 'btn btn-small al-menu-item', it.label); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.addEventListener('click', () => { d.open = false; it.run(); }); pop.append(b); }
    d.addEventListener('keydown', e => { if (e.key === 'Escape') { d.open = false; sum.focus(); } });
    d.append(sum, pop);
    return d;
}

/** One row. `x`: { parts(r) -> { did, on, detail, about }, opens(r), openRow(r), openLabel(r), teamWords(r), fromWords(r), keyOf(r) }. */
export function ledgerRow(r, x) {
    const p = x.parts(r), kind = tileKind(r), v = verdictOf(r), open = x.opens(r);
    const li = el('li', `al-row${r.action === 'wait_send' ? ' is-noise' : ''}`); li.dataset.key = x.keyOf(r); li.dataset.kind = kind || 'other';
    const fk = kind === 'file' || kind === 'image' ? fileKindOf(r.title) : null; // a file's tile says its type (document, video, image, code), not just "file"
    const tile = el('span', `al-tile al-tile-${kind || 'other'}${fk ? ` al-fk-${fk.kind}` : ''}`); tile.setAttribute('aria-hidden', 'true');
    tile.append(fk && fk.glyph ? el('span', 'al-glyph', fk.glyph) : el('span', 'material-icons', fk ? fk.icon : TILE[kind] || 'info'));
    if (fk && fk.kind === 'image' && x.thumbUrl) { // a stored picture is drawn as the Inbox list draws it: its own thumbnail in the tile (the icon stands until it loads, or for a file with none)
        const item = { name: r.title, id: String(r.version || r.item_id || '') }, path = thumbnailPath(item);
        if (path) { tile.classList.add('al-tile-thumb'); tile.replaceChildren(artifactThumbnail(item, { size: 32, url: x.thumbUrl(path, r) })); }
    }
    const main = el('div', 'al-main'), head = el('div', 'al-head');
    const title = open ? el('button', 'al-title', p.on) : el('span', 'al-title al-title-plain', p.on);
    if (open) { title.type = 'button'; title.setAttribute('aria-label', `${p.on}. ${p.about ? `${p.about}. ` : ''}Open ${x.openLabel(r)}`); title.addEventListener('click', () => x.openRow(r)); }
    head.append(title, el('span', `al-verdict al-v-${v}`, p.did));
    if (r.file_n) head.append(el('span', 'al-vchip', `v${r.file_n}`)); // the version this row acted on (the upload records' number)
    if (r.file_n && r.file_latest_n > r.file_n) head.append(el('span', 'al-vnewer', `v${r.file_n} reviewed \u00b7 v${r.file_latest_n} newer`));
    main.append(head);
    if (r.ask) main.append(el('div', 'al-ask', r.ask)); // the question the file was sent with, kept on the row when it was decided
    const said = p.detail.replace(/^from [^\u00b7]+(?: \u00b7 |$)/, ''); // who asked is the meta line's: the callout holds what you said
    if (said) { // the callout says what the words are: the note you approved with, the changes you asked for
        const note = el('div', `al-answer al-ans-${v}`), label = r.item_kind === 'file' ? ({ approved: 'Approved with note:', approve: 'Approved with note:', changes: 'Changes requested:', deny: 'Denied:' })[r.action] : '';
        if (label) note.append(el('b', 'al-ans-label', label), document.createTextNode(' ')); note.append(said); main.append(note);
    }
    if (said && r.item_kind === 'question') {
        const qa = el('details', 'al-qa'), sum = el('summary', null, 'Preview Q&A (2 messages)'), body = el('div', 'al-qa-body');
        for (const [who, text] of [[x.fromWords(r) || 'An agent', p.on], ['You', said]]) { const m = el('div', 'al-qa-msg'); m.append(el('b', 'al-qa-who', who), el('span', 'al-qa-text', text)); body.append(m); }
        qa.append(sum, body); main.append(qa);
        // the real thread, read when the preview is opened: up to the first three messages (question, answer, next reply); the two above stand if the board has no more
        if (x.threadFor) qa.addEventListener('toggle', async () => {
            if (!qa.open || qa.dataset.read) return; qa.dataset.read = '1';
            let msgs = []; try { msgs = await x.threadFor(r); } catch { msgs = []; }
            if (msgs.length < 2) return;
            const first = msgs.slice(0, 3); body.replaceChildren();
            for (const m of first) { const row = el('div', 'al-qa-msg'); row.append(el('b', 'al-qa-who', m.who), el('span', 'al-qa-text', m.text)); body.append(row); }
            sum.textContent = `Preview Q&A (${first.length}${msgs.length > 3 ? ` of ${msgs.length}` : ''} messages)`;
        });
    }
    const meta = el('div', 'al-meta');
    meta.append(el('span', 'al-author', x.fromWords(r) || 'You'), el('span', 'al-sr', `. Done from ${x.doneFrom(r)}. `));
    if (p.about) p.about.split(' · Task #').forEach((part, i) => { if (i) meta.append(el('span', 'al-sr', ' · ')); const full = i ? `Task #${part}` : part, [short, ...rest] = full.split(' \u00b7 '), c = el('span', 'chip chip-tag al-chip', short); if (rest.length) { c.title = full; c.append(el('span', 'al-sr', ` \u00b7 ${rest.join(' \u00b7 ')}`)); } meta.append(c); }); // short label as in the mock ("Goal #259", "Task #19787"); the title is in the tooltip and read out in full
    if (r.source === 'hub') meta.append(el('span', 'chip chip-tag al-via', 'via Coral Hub')); // the decision came through Coral Hub (the record's source)
    main.append(meta);
    const right = el('div', 'al-right'), rm = el('div', 'al-right-meta');
    const team = x.teamWords(r); // a row with no team has no team name and no dot before the time (#19871)
    if (team) rm.append(el('span', 'al-team', team), el('span', 'al-dot', '·'));
    rm.append(timeCell(r.at));
    right.append(rm);
    if (open) { const word = r.item_kind === 'file' && r.file_n && r.file_latest_n > r.file_n ? `Open v${r.file_n}` : OPEN_WORD[r.item_kind] || 'Open'; const b = el('button', 'btn btn-small al-open', word); b.type = 'button'; b.setAttribute('aria-label', `${word}: ${x.openLabel(r)}`); b.addEventListener('click', () => (x.openPrimary || x.openRow)(r)); const acts = el('div', 'al-actions'); acts.append(b); const vs = versionsOf(r, x); if (vs) acts.append(vs); right.append(acts); }
    const more = moreMenu(r, x); if (more) (right.querySelector('.al-actions') || right.appendChild(el('div', 'al-actions'))).append(more);
    li.append(tile, main, right);
    return li;
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
        } else {
            const head = dayWords(r.at, now);
            if (head !== lastHead) { lastHead = head; const n = rows.filter(q => dayWords(q.at, now) === head).length, h = el('li', 'al-date-head'); h.append(el('span', '', head), el('span', 'al-day-count', String(n))); ul.append(h); }
        }
        ul.append(ledgerRow(r, x));
    }
    return ul;
}
