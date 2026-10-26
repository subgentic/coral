/* The mailbox's chat folders (#7776, UI/UX's mock #7773): All chats, Group chats, With notes, Starred, Active now and Archived; by CLI (Claude, Codex, Antigravity, Pi); and the chat tags. One chat is one line of
 * the one table (data_table.js): the agent, the chat's title with a snippet after it, when it last spoke and how long it ran; the days are its dividers, the list grows as it is read (the footer scrolls into view),
 * and the folders' counts come from one grouped read (GET /api/sessions/history/counts). A chat is starred or archived with its own two quiet buttons (PATCH /api/sessions/history/{id}/flags: only the person).
 *   chatSections(counts)        -> the view list's sections for the chat folders
 *   chatFolder(key, counts)     -> { title, params } for a folder key, or null when the key is not a chat folder
 *   chatsSpec(key, ctx)         -> the table spec sidebar_groups.js draws (title, rows, node, signature, empty)
 *   loadChatCounts(redraw)      the counts, read again (after a flag, on the Inbox's own refresh)
 * Text of a chat (its title, the agent's name, a tag) is written by an agent or a person: it is only ever textContent. */
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const { historyFetch } = await importOnce('./history_source.js');
const { historyLabel } = await importOnce('./history_label.js');

const PAGE = 50;
export const CHAT_KEY = /^chats(-|$)/;
const CLIS = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['pi', 'Pi']];
const FOLDERS = [
    { key: 'chats', label: 'All chats', params: { type: 'all' }, count: 'all' },
    { key: 'chats-group', label: 'Group chats', params: { type: 'group' }, count: 'group' },
    { key: 'chats-notes', label: 'With notes', params: { type: 'agent', with_notes: '1' }, count: 'notes' },
    { key: 'chats-starred', label: 'Starred', params: { starred: '1' }, count: 'starred' },
    { key: 'chats-active', label: 'Active now', params: { active: '1' }, count: 'active' },
    { key: 'chats-archived', label: 'Archived', params: { archived: '1' }, count: 'archived' },
];
let counts = null; // the last answer of the counts route

export function chatFolder(key, c = counts) {
    const f = FOLDERS.find(x => x.key === key);
    if (f) return { title: f.label, params: f.params };
    const cli = /^chats-cli-(.+)$/.exec(key), tag = /^chats-tag-(\d+)$/.exec(key);
    if (cli) { const known = CLIS.find(x => x[0] === cli[1]); return { title: known ? known[1] : cli[1], params: { type: 'agent', source_types: cli[1] } }; }
    if (tag) { const t = ((c && c.tags) || []).find(x => String(x.id) === tag[1]); return { title: t ? t.name : 'Tag', params: { type: 'agent', tag_ids: tag[1] } }; }
    return null;
}

/** The view list's sections for the chat folders, with the counts the last read gave (a folder with none yet shows no number). */
export function chatSections(c = counts) {
    const n = (v) => (c && Number.isFinite(c[v]) ? c[v] : undefined);
    const by = (t) => (c && c.by_agent_type ? (t === 'agy' ? (c.by_agent_type.agy || 0) + (c.by_agent_type.antigravity || 0) + (c.by_agent_type.gemini || 0) : c.by_agent_type[t]) : undefined);
    const out = [{ title: 'Chats', items: FOLDERS.map(f => ({ key: f.key, label: f.label, count: n(f.count) })) },
        { title: 'By CLI', items: CLIS.map(([t, label]) => ({ key: `chats-cli-${t}`, label, count: by(t) })) }];
    const tags = (c && c.tags) || [];
    if (tags.length) out.push({ title: 'Tags', items: tags.map(t => ({ key: `chats-tag-${t.id}`, label: t.name, count: t.count, dot: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : undefined })) });
    return out;
}

export async function loadChatCounts(redraw) {
    try {
        const r = await historyFetch('/api/sessions/history/counts');
        if (r && r.ok) counts = await r.json();
    } catch { /* the folders keep their last counts */ }
    redraw?.();
    return counts;
}

// ── a folder's rows: read a page at a time, from the first, again when the folder or the search changes ──
const lists = new Map(); // folder key + search -> { rows, page, total, done, busy, error }
const listOf = (key, q) => { const k = `${key}|${q}`; if (!lists.has(k)) lists.set(k, { rows: [], page: 0, total: null, done: false, busy: false, error: '' }); return lists.get(k); };
async function readMore(key, folder, q, redraw) {
    const L = listOf(key, q);
    if (L.busy || L.done) return;
    L.busy = true; // no redraw here: the spec is being built inside a draw, and a nested draw would close the table it is drawing (the empty line already says Loading)
    try {
        const p = new URLSearchParams({ ...folder.params, page: String(L.page + 1), page_size: String(PAGE) });
        if (q) p.set('q', q);
        const r = await historyFetch(`/api/sessions/history?${p}`);
        if (!r || !r.ok) throw new Error('chats could not be read');
        const d = await r.json();
        const rows = Array.isArray(d.sessions) ? d.sessions : [];
        L.rows = L.rows.concat(rows); L.page += 1; L.total = Number.isFinite(d.total) ? d.total : L.rows.length; L.error = '';
        L.done = !rows.length || L.rows.length >= L.total;
    } catch (e) { L.error = e.message || 'Chats could not be read'; L.done = true; }
    L.busy = false; redraw();
}
/** Forget what was read (a chat was starred or archived): the folders are read again from their first page. */
function resetChatLists() { lists.clear(); }

const isGroup = (s) => s.type === 'group' || String(s.session_id || '').startsWith('board:');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The divider a chat is under: Today, Yesterday, the weekday for the week before, then the date ("Oct 17", with the year when it is not this one). */
function dayOf(iso, now = new Date()) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return 'Date unknown';
    const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day0(now) - day0(d)) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return DAYS[d.getDay()];
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}
const stampOf = (s) => s.last_timestamp || s.updated_at || '';
const ran = (sec) => { if (sec == null || !(sec >= 0)) return ''; const m = Math.round(sec / 60); return m < 1 ? 'under a min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
const name = (s) => (isGroup(s) ? (s.title || String(s.session_id).replace(/^board:/, '')) : (s.display_name || s.agent_name || ''));
const snippetOf = (s) => { const t = historyLabel(s); const x = String(s.summary || '').replace(/\s+/g, ' ').trim(); return x && x !== t ? x : ''; };

/** Star or archive a chat (the flags route): true when it was saved; a failure says so in a toast. */
export async function setChatFlag(sessionId, flag, value) {
    try {
        const r = await historyFetch(`/api/sessions/history/${encodeURIComponent(sessionId)}/flags`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [flag]: value }) });
        if (!r || !r.ok) throw new Error('not saved');
    } catch { (await importOnce('./utils.js')).showToast?.('The chat could not be changed', true); return false; }
    resetChatLists();
    return true;
}
async function setFlag(s, flag, value, after) { if (await setChatFlag(s.session_id, flag, value)) after(); }

/** The table spec of a chat folder. ctx: { query, open(session), redraw(), after() } (open: the chat in the viewer; redraw: draw the table again; after: counts and rows read again). */
export function chatsSpec(key, ctx) {
    const folder = chatFolder(key);
    if (!folder) return null;
    const q = (ctx.query || '').trim();
    const L = listOf(key, q);
    if (!L.page && !L.busy && !L.done) readMore(key, folder, q, ctx.redraw);
    const rows = L.rows;
    return { title: folder.title, rows, empty: { line: L.busy || !L.page ? 'Loading chats…' : (q ? 'No chat matches the search.' : 'No chats here.') },
        signature: JSON.stringify([key, q, L.busy, L.done, L.error, rows.map(s => [s.session_id, s.title, s.summary, stampOf(s), s.starred, s.archived, s.active, s.duration_sec])]),
        node: () => DT.dataTable({ label: `${folder.title}, ${rows.length}`, rows, rowKey: s => s.session_id, state: DT.tableState(), rowName: s => name(s) || historyLabel(s),
            groupBy: s => ({ key: dayOf(stampOf(s)), label: dayOf(stampOf(s)) }),
            open: s => ctx.open(s),
            footer: (L.done && !L.error) ? undefined : { text: L.error || (L.done ? '' : (L.total != null ? `Showing ${rows.length} of ${L.total}` : '')), auto: !L.done && !L.error, more: L.done ? null : { label: 'Load more', busy: L.busy, run: () => readMore(key, folder, q, ctx.redraw) } },
            columns: [
                { key: 'agent', label: 'Agent', primary: true, line: 1, cell: s => { const n = name(s); const w = isGroup(s) ? DT.primaryButton(n || 'Group chat') : DT.personButton(n || 'Agent', `Open the chat of ${n || 'the agent'}`); const b = w.matches('button') ? w : w.querySelector('.dt-primary'); b.dataset.sessionId = s.session_id; if (isGroup(s)) { const wrap = DT.el('span', 'dt-person'); wrap.append(b, DT.tag('Group')); return wrap; } return w; } },
                { key: 'chat', label: 'Chat', width: 'grow', line: 2, cell: s => { const c = DT.el('span', 'dt-chat-line'); c.append(DT.el('span', 'dt-chat-title', historyLabel(s))); const sn = snippetOf(s); if (sn) c.append(DT.el('span', 'dt-chat-snippet', ` – ${sn}`)); if (s.active) { const live = DT.el('span', 'dt-chat-live', ' · active now'); c.append(live); } return c; } },
                { key: 'when', label: 'When', tone: 'tertiary', align: 'end', line: 1, cell: s => DT.timeCell(stampOf(s)) },
                { key: 'ran', label: 'Ran', tone: 'tertiary', align: 'end', line: 0, cell: s => ran(s.duration_sec) },
                { key: 'flags', label: 'Star and archive', hideLabel: true, line: 0, cell: s => {
                    const w = DT.el('span', 'dt-chat-flags');
                    // icon buttons that show on the row's hover or focus (the star stays drawn when set); a phone has them in the opened chat
                    const flag = (key, on, icon, label, pressed) => { const b = DT.el('button', `dt-flag${key === 'starred' && on ? ' dt-flag-on' : ''}`); b.type = 'button'; b.title = label; b.setAttribute('aria-label', `${label}: ${name(s) || historyLabel(s)}`); if (pressed) b.setAttribute('aria-pressed', String(!!on)); const i = DT.el('span', 'material-icons', icon); i.setAttribute('aria-hidden', 'true'); b.append(i); b.addEventListener('click', (e) => { e.stopPropagation(); setFlag(s, key, !on, ctx.after); }); return b; };
                    w.append(flag('starred', s.starred, 'star', s.starred ? 'Remove the star' : 'Star', true), flag('archived', s.archived, s.archived ? 'unarchive' : 'archive', s.archived ? 'Unarchive' : 'Archive', false)); return w; } },
            ] }).el };
}
