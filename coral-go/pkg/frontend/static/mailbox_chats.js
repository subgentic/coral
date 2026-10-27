import { inboxSources, serverColumns, multipleServers } from './inbox_servers.js';
import { serverFetch, isCloud } from './server_base.js';
/* The mailbox's chat folders (#7776, UI/UX's mock #7773): All chats, Board history, With notes, Starred, Active now and Archived; by CLI (Claude, Codex, Antigravity, Pi); and the chat tags. One chat is one line of
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
    { key: 'chats', label: 'All chats', params: { type: 'agent' }, count: 'all' }, // the agents' chats: the boards' have their own folder
    { key: 'chats-group', label: 'Board history', params: { type: 'group' }, count: 'group' },
    { key: 'chats-notes', label: 'With notes', params: { type: 'agent', with_notes: '1' }, count: 'notes' },
    { key: 'chats-starred', label: 'Starred', params: { starred: '1' }, count: 'starred' },
    { key: 'chats-active', label: 'Active now', params: { type: 'agent', active: '1' }, count: 'active' },
    { key: 'chats-archived', label: 'Archived', params: { type: 'agent', archived: '1' }, count: 'archived' },
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

/** A folder's total from the last counts read (undefined until it is known): the number beside the folder and the one in the table's heading, so the two never differ. */
export function folderCount(key, c = counts) {
    const n = (v) => (c && Number.isFinite(c[v]) ? c[v] : undefined);
    const f = FOLDERS.find(x => x.key === key);
    if (f) return n(f.count); // each count is its folder's total, as the counts route sends it (#8065)
    const cli = /^chats-cli-(.+)$/.exec(key), tag = /^chats-tag-(\d+)$/.exec(key);
    if (cli) { const t = cli[1], by = c && c.by_agent_type; return by ? by[t] : undefined; } // the server already gives agy, antigravity and gemini the one count of their shared history: shown as it is, not added three times (#8011)
    if (tag) { const t = ((c && c.tags) || []).find(x => String(x.id) === tag[1]); return t ? t.count : undefined; }
    return undefined;
}

/** The view list's sections for the chat folders, with the counts the last read gave (a folder with none yet shows no number). */
export function chatSections(c = counts) {
    const out = [{ title: 'Chats', items: FOLDERS.map(f => ({ key: f.key, label: f.label, count: folderCount(f.key, c) })) },
        { title: 'By CLI', items: CLIS.map(([t, label]) => ({ key: `chats-cli-${t}`, label, count: folderCount(`chats-cli-${t}`, c) })) }];
    const tags = (c && c.tags) || [];
    if (tags.length) out.push({ title: 'Tags', items: tags.map(t => ({ key: `chats-tag-${t.id}`, label: t.name, count: t.count, dot: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : undefined })) });
    return out;
}

/** The chat tags there are (from the last counts read): id, name, count, colour. */
export const chatTags = () => (counts && counts.tags) || [];

export async function loadChatCounts(redraw) {
    try {
        const replies = await Promise.all(inboxSources().map(async server => { const r = await serverFetch(server, '/api/sessions/history/counts'); if (!r.ok) throw new Error('Chat counts unavailable'); return r.json(); }));
        counts = { ...replies[0], by_agent_type: Object.create(null) };
        for (const key of ['all','group','notes','starred','active','archived']) counts[key] = replies.reduce((sum, d) => sum + (Number(d[key]) || 0), 0);
        for (const d of replies) for (const [key, value] of Object.entries(d.by_agent_type || {})) counts.by_agent_type[key] = (counts.by_agent_type[key] || 0) + value;
    } catch { /* the folders keep their last counts */ }
    redraw?.();
    return counts;
}

// ── a folder's rows: read a page at a time, from the first, again when the folder or the search changes ──
const lists = new Map(); // folder key + search + filters -> { rows, page, total, done, busy, error }
const listOf = (key, q, extra = '') => { const k = `${inboxSources().join(",")}|${key}|${q}|${extra}`; if (!lists.has(k)) lists.set(k, { rows: [], page: 0, total: null, done: false, busy: false, error: '' }); return lists.get(k); };
async function readMore(key, folder, q, extra, redraw) {
    const L = listOf(key, q, JSON.stringify(extra));
    if (L.busy || L.done) return;
    L.busy = true; // no redraw here: the spec is being built inside a draw, and a nested draw would close the table it is drawing (the empty line already says Loading)
    try {
        const { server: selected, ...query } = extra;
        const p = new URLSearchParams({ ...query, ...folder.params, page: String(L.page + 1), page_size: String(PAGE) }); // the folder's own rule wins over a filter
        if (q) p.set('q', q);
        const sources = inboxSources().filter(server => (!selected || server === selected) && (!p.has('tag_ids') || server === 'local'));
        const replies = await Promise.all(sources.map(async server => {
            const r = await serverFetch(server, `/api/sessions/history?${p}`);
            if (!r.ok) throw new Error('Chats could not be read');
            const d = await r.json(); return { ...d, sessions: (d.sessions || []).map(row => ({ ...row, server })) };
        }));
        const rows = replies.flatMap(d => d.sessions);
        const d = { total: replies.reduce((sum, d) => sum + (Number(d.total) || d.sessions.length), 0) };
        L.rows = L.rows.concat(rows).sort((a,b) => stampOf(b).localeCompare(stampOf(a))); L.page += 1; L.total = Number.isFinite(d.total) ? d.total : L.rows.length; L.error = '';
        L.done = !rows.length || L.rows.length >= L.total;
        if (L.page > 1 && rows.length) importOnce('./notifications.js').then(m => m.announceNotice(`${rows.length} more chats loaded`)).catch(() => {}); // heard once: the rows came in below the footer the person was on (#8022)
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
/** The line after a chat's title. A group chat's summary starts with its own name ("orch-notify - 1 messages, 0 participants"): the name is not said twice, and one is "1 message". */
const snippetOf = (s) => {
    const t = historyLabel(s);
    let x = String(s.summary || '').replace(/\s+/g, ' ').trim();
    if (isGroup(s)) {
        for (const n of [t, String(s.session_id || '').replace(/^board:/, '')]) if (n && x.startsWith(n)) { x = x.slice(n.length).replace(/^\s*[-\u2013\u2014:]\s*/, ''); break; }
        x = x.replace(/\b1 messages\b/, '1 message').replace(/\b1 participants\b/, '1 participant');
    }
    return x && x !== t ? x : '';
};

/** Star or archive a chat (the flags route): true when it was saved; a failure says so in a toast. */
export async function setChatFlag(sessionId, flag, value, server = null) {
    try {
        if (isCloud() || (server && server !== 'local')) throw new Error('Remote history is read-only');
        const read = server ? (url, options) => serverFetch(server, url, options) : historyFetch;
        const r = await read(`/api/sessions/history/${encodeURIComponent(sessionId)}/flags`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [flag]: value }) });
        if (!r || !r.ok) throw new Error('not saved');
    } catch { (await importOnce('./utils.js')).showToast?.('The chat could not be changed', true); return false; }
    resetChatLists();
    return true;
}
async function setFlag(s, flag, value, after) { if (await setChatFlag(s.session_id, flag, value, s.server)) after(); }

/** The table spec of a chat folder. ctx: { query, params, open(session), redraw(), after() } (params: the Filters' extra parameters of the history read, chat_filters.js; open: the chat in the viewer; redraw: draw the table again; after: counts and rows read again). */
export function chatsSpec(key, ctx) {
    const folder = chatFolder(key);
    if (!folder) return null;
    const q = (ctx.query || '').trim();
    const extra = { ...(ctx.params || {}), ...(multipleServers() && ctx.server ? { server: ctx.server } : {}) }, filtered = !!q || Object.keys(extra).length > 0;
    const L = listOf(key, q, JSON.stringify(extra));
    if (!L.page && !L.busy && !L.done) readMore(key, folder, q, extra, ctx.redraw);
    const rows = L.rows;
    return { title: folder.title, noun: ['chat', 'chats'], rows, count: folderCount(key) ?? null, empty: { line: L.busy || !L.page ? 'Loading chats…' : (filtered ? 'No chat matches the search and filters.' : 'No chats here.') },
        signature: JSON.stringify([key, q, extra, folderCount(key), L.busy, L.done, L.error, rows.map(s => [s.server, s.session_id, s.title, s.summary, stampOf(s), s.starred, s.archived, s.active, s.duration_sec])]),
        node: () => DT.dataTable({ label: `${folder.title}, ${folderCount(key) ?? rows.length}`, rows, rowKey: s => `${s.server}:${s.session_id}`, state: DT.tableState(), rowName: s => name(s) || historyLabel(s),
            groupBy: s => ({ key: dayOf(stampOf(s)), label: dayOf(stampOf(s)) }),
            open: s => ctx.open(s),
            footer: (L.done && !L.error) ? undefined : { text: L.error || (L.done ? '' : (L.total != null ? `Showing ${rows.length} of ${L.total}` : '')), auto: !L.done && !L.error, more: L.done ? null : { label: 'Load more', busy: L.busy, run: () => readMore(key, folder, q, extra, ctx.redraw) } },
            columns: [
                ...serverColumns(),
                { key: 'agent', label: key === 'chats-group' ? 'Name' : 'Agent', primary: true, line: 1, cell: s => { const n = name(s); const w = isGroup(s) ? DT.primaryButton(n || 'Board') : DT.personButton(n || 'Agent', `Open the chat of ${n || 'the agent'}`); const b = w.matches('button') ? w : w.querySelector('.dt-primary'); b.dataset.sessionId = s.session_id; if (isGroup(s)) { const wrap = DT.el('span', 'dt-person'); wrap.append(b, DT.tag('Board')); return wrap; } return w; } },
                { key: 'chat', label: 'Chat', width: 'grow', line: 2, cell: s => { /* a board's name is the agent column's: its line says only what happened in it */ const c = DT.el('span', 'dt-chat-line'); const sn = snippetOf(s); if (isGroup(s)) { if (sn) c.append(DT.el('span', 'dt-chat-snippet', sn)); } else { c.append(DT.el('span', 'dt-chat-title', historyLabel(s))); if (sn) c.append(DT.el('span', 'dt-chat-snippet', ` \u2013 ${sn}`)); } if (s.active) { const live = DT.el('span', 'dt-chat-live', ' · active now'); c.append(live); } /* an archived board stays in Board history, marked */ if (s.archived && key !== 'chats-archived') c.append(DT.tag('Archived')); return c; } },
                { key: 'when', label: 'When', tone: 'tertiary', align: 'end', line: 1, cell: s => DT.timeCell(stampOf(s)) },
                { key: 'ran', label: 'Ran', tone: 'tertiary', align: 'end', line: 0, cell: s => ran(s.duration_sec) },
                { key: 'flags', label: 'Star and archive', hideLabel: true, line: 0, cell: s => {
                    if (isCloud() || (s.server && s.server !== 'local')) return '';
                    const w = DT.el('span', 'dt-chat-flags');
                    // icon buttons that show on the row's hover or focus (the star stays drawn when set); a phone has them in the opened chat
                    const flag = (key, on, icon, label, pressed) => { const b = DT.el('button', `dt-flag${key === 'starred' && on ? ' dt-flag-on' : ''}`); b.type = 'button'; b.title = label; b.setAttribute('aria-label', `${label}: ${name(s) || historyLabel(s)}`); if (pressed) b.setAttribute('aria-pressed', String(!!on)); const i = DT.el('span', 'material-icons', icon); i.setAttribute('aria-hidden', 'true'); b.append(i); b.addEventListener('click', (e) => { e.stopPropagation(); setFlag(s, key, !on, ctx.after); }); return b; };
                    w.append(flag('starred', s.starred, 'star', s.starred ? 'Remove the star' : 'Star', true), flag('archived', s.archived, s.archived ? 'unarchive' : 'archive', s.archived ? 'Unarchive' : 'Archive', false)); return w; } },
            ] }).el };
}
