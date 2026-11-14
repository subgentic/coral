/* The team page's Knowledge tab (#7453 stage 3): what the team knows as a table (Entry, Updated, From), "Distill knowledge" in the bar, and a row opens the right sidebar with the entry (#7761).
 * An entry is the team's index or one agent's distilled notes (GET /api/teams/detail/{team}/knowledge), Markdown with a YAML front matter. The pane shows the front matter as a block of facts (type, title, tags as chips, the
 * time as words with the exact one on hover) and the rest through the safe renderer (safe_markdown.js, as the Inbox and a task's text): distilled from agents' words, it is never run as HTML here, and a link to another
 * entry (./orchestrator.md) opens that entry in the same pane. When a distillation ends, the entry it wrote opens there. The sidebar is the documents pane with its resize handle (detail_pane.js, the goal page's column).
 * Everything is built with the DOM and textContent. Lazy: team_page.js imports it. */
import { importOnce } from './import_once.js';
import { teamFetch } from './server_base.js';
import { refusedTooLarge } from './utils.js';
import { whenText } from './when_text.js';
import { refreshDistill, startDistill, distillJob } from './knowledge_distill.js';
const { splitFrontMatter, entryForLink, slugOf } = await importOnce('./knowledge_text.js'); // the entry's front matter and its links (pure)
const { renderSafe } = await importOnce('./safe_markdown.js'); // the Inbox's renderer: DOM-built, no markup from text
const { loadSafeMarkdown } = await importOnce('./vendor_loader.js');
const Toolbar = await importOnce('./team_toolbar.js'); // the one toolbar of the team tabs (#7717)
const { rowFocusTarget, el } = await importOnce('./team_table.js'); // lazy modules load the others they need through importOnce, so a failed load is retried
const { openDetailPane, closeDetailPane, detailKey } = await importOnce('./detail_pane.js');

const DT = await importOnce('./data_table.js');
let knowledgeTableState = DT.tableState();

const model = { team: '', data: null, refused: false, failed: '', loading: false, search: '' };
let root = null, hooks = {};
const say = (t) => { const s = root && root.querySelector('.team-knowledge-status'); if (s) { s.textContent = ''; s.textContent = t; } };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

const NOTE = 'note-'; // a hand-written note is the file note-<title>.md; every agent of the team reads the notes when it starts (#16685)
const isNote = (name) => String(name).startsWith(NOTE) && String(name).length > NOTE.length;
const shownName = (e) => e.label || e.name;

/** The table's entries: the team's index first, then each agent's notes by name. */
function entriesOf(data) {
    if (!data || !data.exists) return [];
    const out = [];
    if (data.index) out.push({ key: 'index', name: 'Index', text: data.index, from: 'The whole team' });
    for (const a of [...(data.agents || [])].sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
        if (isNote(a.name)) { const t = splitFrontMatter(a.content || '').facts; out.push({ key: `agent:${a.name}`, name: a.name, label: (t && t.title) || a.name.slice(NOTE.length).replace(/-/g, ' '), text: a.content || '', from: 'Added by hand', note: true }); } // a note a person wrote (#16685)
        else out.push({ key: `agent:${a.name}`, name: a.name, text: a.content || '', from: `${a.name}'s sessions` });
    }
    return out;
}

async function load() {
    const team = model.team; if (!team) return;
    if (!model.data) { model.loading = true; draw(); }
    let refused = false;
    const data = await teamFetch(team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge`)
        .then(async r => { if (r.ok) return r.json(); refused = await refusedTooLarge(r); return null; }).catch(() => null);
    if (team !== model.team) return;
    model.loading = false; model.refused = refused;
    if (data) { model.data = data; model.failed = ''; hooks.onCount?.(entriesOf(data).length); }
    else if (!refused) model.failed = 'The knowledge could not be read.';
    draw();
}

const exactTime = (stamp) => { const d = new Date(stamp); return stamp && !Number.isNaN(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; };

/** The entry's front matter as a quiet block of facts: type, title, description and tags as chips. The time is the pane's header line alone (one time format, UI/UX on #7761). */
function factsBlock(f) {
    const dl = el('dl', 'facts detail-facts');
    const row = (k, v) => { dl.append(el('dt', null, k), v); };
    if (f.type) row('Type', el('dd', null, f.type));
    if (f.title) row('Title', el('dd', null, f.title));
    if (f.description) row('About', el('dd', null, f.description));
    if (f.tags.length) { const dd = el('dd'), box = el('span', 'knowledge-tags'); for (const t of f.tags) box.append(el('span', 'chip chip-tag knowledge-tag', t)); dd.append(box); row('Tags', dd); }
    return dl.children.length ? dl : null;
}

/** Draws the entry's Markdown in `host` (its front matter is the pane's Details, entryFacts). The text is on screen as plain text first, and the rendered DOM replaces it when the renderer is there (a failed load leaves the plain text, never markup).
 *  A link to another entry of the team opens it through `open`; any other relative link is plain text. */
async function showEntry(host, entry, open) {
    host.replaceChildren();
    if (!entry.text) { host.append(Object.assign(el('pre', 'team-task-text knowledge-text'), { textContent: 'Nothing written yet.' })); return; }
    const { body } = splitFrontMatter(entry.text); // the front matter is behind the pane's Details button (#7775), not above the text
    const plain = Object.assign(el('pre', 'team-task-text knowledge-text'), { textContent: body });
    host.append(plain);
    try {
        await loadSafeMarkdown().catch(() => {});
        const entries = entriesOf(model.data);
        const linkPolicy = (url) => { const e = entryForLink(url, entries); if (e) return { href: `/team-knowledge/${encodeURIComponent(e.key)}`, shown: '', internal: true }; return /^\.{1,2}\//.test(String(url)) ? false : undefined; };
        const text = body.replace(/\[([^\]\n]*)\]\((\.{1,2}\/[^)\s]*)\)/g, (m, label, url) => (entryForLink(url, entries) ? m : label)); // a link to a file that is no entry of this team is its words, not "[words](./file.md)"
        const { node, partial } = renderSafe(text, { linkPolicy });
        if (partial || !host.isConnected || !plain.isConnected) return; // the renderer did not load: the plain text stays; or the pane moved on
        node.classList.add('knowledge-md');
        for (const a of node.querySelectorAll('a[href^="/team-knowledge/"]')) { const host2 = a.nextElementSibling; if (host2 && host2.classList.contains('md-host')) host2.remove(); } // the renderer names a link's host after it; an entry of this team needs no host
        const go = (ev) => {
            const a = ev.target instanceof Element ? ev.target.closest('a[href^="/team-knowledge/"]') : null;
            if (!a) return;
            ev.preventDefault();
            if (ev.type === 'auxclick') return;
            const key = decodeURIComponent(a.getAttribute('href').slice('/team-knowledge/'.length));
            const e = entriesOf(model.data).find(x => x.key === key);
            if (e) open(e);
        };
        node.addEventListener('click', go); node.addEventListener('auxclick', go);
        plain.replaceWith(node);
    } catch { /* the plain text stays */ }
}

/** The entry's front matter as the block the pane's Details button holds, or null when it has none. */
const entryFacts = (entry) => { const { facts } = splitFrontMatter(entry.text || ''); return facts ? factsBlock(facts) : null; };

function openEntry(entry, opener, { focus = true } = {}) {
    let more = null;
    const showFacts = () => { if (!more) return; more.clear(); const b = entryFacts(entry); if (b) more.add(b); };
    const when = model.data && model.data.created_at;
    const editable = entry.key !== 'index'; // the team's index is written by the distillation; an agent's notes can be changed by hand
    let bodyHost = null, editButton = null, status = null;
    const foot = () => document.querySelector('#detail-pane .detail-foot');
    const say = (t) => { if (status) { status.textContent = ''; status.textContent = t; } };
    const showText = () => showEntry(bodyHost, entry, (e) => openEntry(e, opener));
    const toView = (focus = true) => { showFacts(); showText(); foot()?.replaceChildren(status, editButton); if (focus) editButton.focus({ preventScroll: true }); };
    // Edit: the text becomes a box and the pane's bar reads Cancel at the left and Save at the right with a status line; Escape and Cancel ask once, in the bar, when the text was changed.
    function startEdit() {
        const box = el('textarea', 'knowledge-editor'); box.value = entry.text || ''; box.setAttribute('aria-label', `Notes of ${shownName(entry)}`); box.rows = 16;
        const save = btn('btn btn-primary', 'Save', null), cancel = btn('btn', 'Cancel', null);
        const dirty = () => box.value !== (entry.text || '');
        const toEdit = () => { foot()?.replaceChildren(status, cancel, save); };
        const askDiscard = () => {
            const keep = btn('btn', 'Keep editing', () => { toEdit(); box.focus(); }), drop = btn('btn btn-danger', 'Discard', () => { say(''); toView(); }); // Keep editing is the plain button and has the focus; Discard is the danger style, never the blue primary
            const q = el('span', 'detail-status detail-ask', 'Discard your changes?'); q.setAttribute('role', 'alert');
            foot()?.replaceChildren(q, keep, drop); keep.focus();
        };
        const leave = () => { if (dirty()) askDiscard(); else { say(''); toView(); } };
        cancel.addEventListener('click', leave);
        box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leave(); } });
        save.addEventListener('click', async () => {
            save.disabled = true; cancel.disabled = true; say('Saving…');
            try {
                const r = await teamFetch(model.team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge/${encodeURIComponent(entry.name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: box.value }) });
                const b = await r.json().catch(() => ({}));
                if (!r.ok || !b.ok) { say(`Could not save: ${(b && b.error) || `HTTP ${r.status}`}`); save.disabled = false; cancel.disabled = false; return; }
                entry.text = box.value;
                const a = model.data && model.data.agents.find(x => x.name === entry.name); if (a) a.content = box.value;
                toView(); say(b.redacted ? 'Saved. A secret in the text was replaced before it was saved.' : 'Saved.');
                load(); // Updated and the table are read again
            } catch (e) { say(`Could not save: ${e && e.message ? e.message : 'no answer'}`); save.disabled = false; cancel.disabled = false; }
        });
        bodyHost.replaceChildren(box);
        say(''); toEdit();
        box.focus();
    }
    openDetailPane({
        key: entry.key, opener, title: shownName(entry), sub: [entry.note ? '' : whenText(when), entry.from].filter(Boolean).join(' · '), subTitle: exactTime(when), resizable: true, backLabel: 'Knowledge', focus, details: (h) => { more = h; showFacts(); },
        body: (host) => { bodyHost = host; showText(); },
        actions: editable ? [{ label: 'Edit', run: (b) => { editButton = b; startEdit(); } }] : [],
        onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
    });
    if (editable) { // the status line sits in the bar beside the buttons, a live region that stays
        status = el('span', 'detail-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        editButton = foot()?.querySelector('button');
        foot()?.prepend(status);
        foot()?.addEventListener('keydown', (e) => { if (e.key !== 'Escape' || !bodyHost?.querySelector('textarea')) return; e.preventDefault(); e.stopPropagation(); const k = [...foot().querySelectorAll('button')].find(b => b.textContent === 'Keep editing'); if (k) k.click(); else [...foot().querySelectorAll('button')].find(b => b.textContent === 'Cancel')?.click(); });
    }
    root?.querySelectorAll('tr[data-key]').forEach(r => { if (r.dataset.key === entry.key) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
}

/** Add a note (#16685): a title and the text, in the same pane an entry opens in. Saved as the note-<title> entry through the route an edit uses; every agent of the team reads it when it starts. */
function openNewNote(opener) {
    const title = el('input', 'field knowledge-note-title'); title.type = 'text'; title.maxLength = 80; title.autocomplete = 'off'; title.id = 'knowledge-note-title';
    const text = el('textarea', 'knowledge-editor'); text.rows = 12; text.maxLength = 12000; text.id = 'knowledge-note-text';
    const status = el('span', 'detail-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    let save = null;
    const say2 = (t) => { status.textContent = ''; status.textContent = t; };
    openDetailPane({
        key: 'new-note', opener, title: 'Add a note', sub: 'Every agent of this team reads it when it starts.', resizable: true, backLabel: 'Knowledge', focus: false,
        body: (host) => {
            const l1 = el('label', 'knowledge-note-label', 'Title'); l1.htmlFor = title.id;
            const l2 = el('label', 'knowledge-note-label', 'What the team should know'); l2.htmlFor = text.id;
            host.replaceChildren(l1, title, l2, text);
        },
        actions: [{ label: 'Save note', primary: true, run: (b) => { save = b; doSave(); } }],
        onClose: () => { root?.querySelectorAll('tr[aria-current="true"]').forEach(r => r.removeAttribute('aria-current')); },
    });
    const foot = document.querySelector('#detail-pane .detail-foot');
    save = foot?.querySelector('button') || save;
    foot?.prepend(status);
    title.focus({ preventScroll: true });
    async function doSave() {
        const name = title.value.replace(/\s+/g, ' ').trim(), body = text.value.trim(), slug = slugOf(name);
        if (!name || !slug) { say2(name ? 'Use letters or numbers in the title.' : 'Give the note a title.'); title.focus(); return; }
        if (!body) { say2('Write what the team should know.'); text.focus(); return; }
        if (entriesOf(model.data).some(e => e.key === `agent:${NOTE}${slug}`)) { say2('A note with that title exists. Open it to change it, or give this one another title.'); title.focus(); return; }
        const file = NOTE + slug;
        save.disabled = true; say2('Saving…');
        try {
            const r = await teamFetch(model.team, n => `/api/teams/detail/${encodeURIComponent(n)}/knowledge/${encodeURIComponent(file)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `---\ntype: note\ntitle: ${JSON.stringify(name)}\n---\n\n${body}\n` }) });
            const b = await r.json().catch(() => ({}));
            if (!r.ok || !b.ok) { say2(`Could not save: ${(b && b.error) || `HTTP ${r.status}`}`); save.disabled = false; return; }
            say(b.redacted ? 'Note saved. A secret in the text was replaced before it was saved.' : 'Note saved.');
            await load();
            const e = entriesOf(model.data).find(x => x.key === `agent:${file}`);
            if (e) openEntry(e, null); else closeDetailPane();
        } catch (e) { say2(`Could not save: ${e && e.message ? e.message : 'no answer'}`); save.disabled = false; }
    }
}

async function distill() {
    const team = model.team;
    try { await startDistill(team); say('Distilling the team’s knowledge…'); } catch (e) { say(`Could not start: ${e && e.message ? e.message : 'no answer'}`); }
    draw();
}

/** The tabs' one empty line: the sentence, and an optional hint under it. */
function emptyLine(text, hint) { const e = el('div', 'empty-state'); e.append(el('p', 'empty-state-line', text)); if (hint) e.append(el('p', 'empty-state-hint', hint)); return e; }

function draw() {
    const body = root && root.querySelector('.team-knowledge-body'); if (!body) return;
    const a = document.activeElement;
    const held = a && body.contains(a) ? (a.closest('tr[data-key]')?.dataset.key || (a.classList.contains('team-distill') ? '#distill' : a.classList.contains('team-add-note') ? '#add' : '')) : '';
    body.replaceChildren();
    const running = distillJob(model.team).status === 'running';
    const everything = entriesOf(model.data), q = model.search.trim().toLowerCase();
    const entries = q ? everything.filter(e => shownName(e).toLowerCase().includes(q)) : everything;
    const d = btn('btn btn-small team-distill', running ? 'Distilling…' : 'Distill knowledge', distill); d.disabled = running;
    if (running) d.setAttribute('aria-label', 'Distill knowledge, running');
    // The one toolbar line (#7717): the search field and Distill knowledge at the right (no count line: the table is the count).
    const add = btn('btn btn-small team-add-note', 'Add a note', () => openNewNote(add));
    const actions = el('span', 'team-knowledge-actions'); actions.append(add, d); // the toolbar's one action slot holds both: Add a note, then Distill knowledge, which wrap together when the line is short
    body.append(Toolbar.build({ id: 'team-knowledge-search', label: 'Search knowledge', placeholder: 'Search knowledge', value: model.search, onSearch: text => { model.search = text; draw(); }, action: actions }));
    // A run in progress says how long it has gone and what it is doing; a failed one keeps its error here (#15272).
    const job = distillJob(model.team), pr = job.progress || {};
    if (running) {
        const m = Math.floor((Date.now() - Date.parse(job.started_at)) / 60000), at = Number.isFinite(m) ? (m < 1 ? 'Started just now' : `Started ${m} min ago`) : 'Distilling';
        const what = { extracting: `reading ${pr.agent || 'an agent'} (${(pr.completed || 0) + 1} of ${pr.total || '?'})`, 'cross-referencing': 'comparing the agents', formatting: `writing ${pr.agent || 'an agent'} (${(pr.completed || 0) + 1} of ${pr.total || '?'})` }[pr.phase];
        body.append(el('p', 'goals-note team-distill-note', `${at}${what ? `: ${what}` : ''}. It stops by itself after 10 minutes.`));
    } else if (job.status === 'failed') { const f = el('div', 'goals-failed team-distill-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, `The last distilling failed${job.error ? `: ${job.error}` : ''}`)); body.append(f); }
    if (model.failed) { const f = el('div', 'goals-failed'); f.setAttribute('role', 'alert'); f.append(el('span', null, model.failed), btn('btn btn-small', 'Retry', () => load())); body.append(f); }
    if (model.loading) body.append(el('p', 'goals-note', 'Loading knowledge…'));
    else if (model.refused) body.append(emptyLine('This team’s knowledge is too large to show through Coral Hub; open it on the computer.'));
    else if (!entries.length) { if (!model.failed) body.append(everything.length ? emptyLine('No entries match this search.') : emptyLine('No knowledge yet.', 'Add a note to give the team a fact it should know, or Distill knowledge to write what each agent learned from its work.')); }
    else {
        body.append(DT.dataTable({
            label: `Knowledge, ${entries.length}`, rows: entries, rowKey: e => e.key, current: detailKey(), state: knowledgeTableState,
            open: (e, tr) => openEntry(e, tr.querySelector('.dt-primary')),
            columns: [
                { key: 'entry', label: 'Entry', primary: true, width: 'grow', field: 'name', sort: true, line: 1, cell: e => DT.primaryButton(shownName(e)) },
                { key: 'updated', label: 'Updated', sort: 'date', sortValue: () => model.data.created_at, tone: 'tertiary', align: 'end', line: 1, cell: () => DT.timeCell(model.data.created_at) },
                { key: 'from', label: 'From', field: 'from', sort: true, line: 0 }, // a folded row is one line: the entry and when it was updated (#8981)
            ],
        }).el);
    }
    if (held) (held === '#distill' ? body.querySelector('.team-distill') : held === '#add' ? body.querySelector('.team-add-note') : rowFocusTarget(body, held))?.focus({ preventScroll: true });
}

/** The result of a distillation, in the pane (#7761): the entry it wrote or changed (the team's index first) opens in the sidebar when the tab is on screen. Nothing opens when nothing changed or the person is elsewhere
 *  (the toast says the knowledge is ready); the focus stays where it is, the pane's announcement says what opened. */
function openWritten(before) {
    if (!root || !root.isConnected || !root.getClientRects().length || !model.data) return;
    const changed = entriesOf(model.data).filter(e => !before.has(e.key) || before.get(e.key) !== e.text);
    const e = changed.find(x => x.key === 'index') || changed[0];
    if (e) openEntry(e, null, { focus: false });
}

// The run's progress: the button says so while it runs, and the table is read again when it ends.
document.addEventListener('coral:distill-status', (e) => {
    const { team, job, prev } = e.detail || {};
    if (!root || !root.isConnected || team !== model.team) return;
    if (prev && prev.status === 'running' && job.status !== 'running') {
        say(job.status === 'complete' ? 'Knowledge is ready.' : job.status === 'failed' ? `Distilling failed${job.error ? `: ${job.error}` : ''}.` : 'Distilling stopped.');
        const before = new Map(entriesOf(model.data).map(e => [e.key, e.text]));
        load().then(() => openWritten(before));
    } else draw();
});

/** Show the team's knowledge in `host`. hooks: onCount(n). */
export function showKnowledge(host, team, h = {}) {
    if (team !== model.team) { knowledgeTableState = DT.tableState(); Object.assign(model, { team, data: null, refused: false, failed: '', loading: false, search: '' }); }
    hooks = h;
    if (!host.dataset.built) {
        host.dataset.built = '1';
        const page = el('div', 'goals-page goals-table-page');
        const status = el('div', 'team-knowledge-status sr-only'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        page.append(status, el('div', 'team-knowledge-body'));
        host.replaceChildren(page);
    }
    root = host.firstChild;
    draw();
    refreshDistill(team).then(draw, () => {});
    return load();
}

export { closeDetailPane };
