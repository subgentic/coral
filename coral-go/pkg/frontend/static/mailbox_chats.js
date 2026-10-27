import { inboxSources, serverColumns, multipleServers, serverLabel, serverOf } from './inbox_servers.js';
import { serverFetch, isCloud, nativeInbox } from './server_base.js';
/* The mailbox's chat folders (#7776, UI/UX's mock #7773): All chats, Board history, With notes, Starred, Active now and Archived; by CLI (Claude, Codex, Antigravity, Pi); and the chat tags. One chat is one line of
 * the one table (data_table.js): the chat's title, the agent, when it last spoke (and the server with more than one): one line per chat (#8961); the days are its dividers, the list grows as it is read (the footer scrolls into view),
 * and the folders' counts come from one grouped read (GET /api/sessions/history/counts). A chat is starred or archived with its own two quiet buttons (PATCH /api/sessions/history/{id}/flags: only the person).
 *   chatSections(counts)        -> the view list's sections for the chat folders
 *   chatFolder(key, counts)     -> { title, params } for a folder key, or null when the key is not a chat folder
 *   chatsSpec(key, ctx)         -> the table spec sidebar_groups.js draws (title, rows, node, signature, empty)
 *   loadChatCounts(redraw)      the counts, read again (after a flag, on the Inbox's own refresh)
 * Text of a chat (its title, the agent's name, a tag) is written by an agent or a person: it is only ever textContent. */
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const IR = await importOnce('./inbox_read.js'); // which chats and boards the person has opened since they changed (#9687)
const readKey = s => `${s.server}:${s.session_id}`, readKind = s => (isGroup(s) ? 'board' : 'chat');
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
let unread = null; // the last count of unread chats per folder (#9687): { folder key: n }, from the chats changed since the marker began

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

/** A folder's unread chats (undefined at none, and for a folder this count cannot tell: With notes, a tag): the number beside the folder in the sidebar and the drawer (UI/UX #9687); the table's heading keeps the total. */
export const folderUnread = key => (unread && unread[key]) || undefined;

/** The view list's sections for the chat folders: the number beside a folder is its unread chats, its total is the tooltip (a folder with none unread shows no number). */
export function chatSections(c = counts) {
    const item = (key, label) => ({ key, label, count: folderUnread(key), total: folderCount(key, c), unread: true });
    const out = [{ title: 'Chats', items: FOLDERS.map(f => item(f.key, f.label)) },
        { title: 'By CLI', items: CLIS.map(([t, label]) => item(`chats-cli-${t}`, label)) }];
    const tags = (c && c.tags) || [];
    if (tags.length && !nativeInbox()) out.push({ title: 'Tags', items: tags.map(t => ({ key: `chats-tag-${t.id}`, label: t.name, dot: /^#[0-9a-f]{3,8}$/i.test(t.color || '') ? t.color : undefined })) });
    return out;
}

/** The chat tags there are (from the last counts read): id, name, count, colour. */
export const chatTags = () => (counts && counts.tags) || [];

/** The chats changed since the marker began, read once (at most 200 a computer), counted by folder against the read marker: how many of each folder the person has not opened. The Chats list pages by folder, so the total the counts route gives cannot say it. */
async function loadUnread() {
    try {
        const day = new Date(IR.readSince() - 86400000).toISOString().slice(0, 10); // a day early: the stamps are compared exactly below
        const replies = await Promise.all(inboxSources().map(async server => {
            const r = await serverFetch(server, `/api/sessions/history?${new URLSearchParams({ date_from: day, page: '1', page_size: '200' })}`);
            if (!r.ok) return [];
            const d = await r.json(); return (d.sessions || []).map(row => ({ ...row, server }));
        }));
        const rows = replies.flat().filter(s => IR.isUnread(readKind(s), readKey(s), stampOf(s)));
        const next = { chats: rows.filter(s => !isGroup(s)).length, 'chats-group': rows.filter(isGroup).length, 'chats-starred': rows.filter(s => s.starred).length, 'chats-active': rows.filter(s => s.active).length, 'chats-archived': rows.filter(s => s.archived).length };
        for (const [t] of CLIS) { const types = t === 'agy' ? ['agy', 'antigravity', 'gemini'] : [t]; next[`chats-cli-${t}`] = rows.filter(s => !isGroup(s) && types.includes(s.source_type)).length; }
        unread = next;
    } catch { /* the folders keep their last numbers */ }
}

export async function loadChatCounts(redraw) {
    try {
        const sources = inboxSources();
        const read = async server => { const r = await serverFetch(server, '/api/sessions/history/counts'); if (!r.ok) throw new Error('Chat counts unavailable'); return r.json(); };
        // one computer that does not answer must not blank the others' counts on a Hub (the folders add up what answered); a local Coral's one source still fails as a whole
        const replies = isCloud() ? (await Promise.allSettled(sources.map(read))).filter(r => r.status === 'fulfilled').map(r => r.value) : await Promise.all(sources.map(read));
        counts = { ...replies[0], by_agent_type: Object.create(null) };
        if (nativeInbox()) delete counts.tags; // tags are per computer: the Hub-served Inbox has no Tags folder
        for (const key of ['all','group','notes','starred','active','archived']) counts[key] = replies.reduce((sum, d) => sum + (Number(d[key]) || 0), 0);
        for (const d of replies) for (const [key, value] of Object.entries(d.by_agent_type || {})) counts.by_agent_type[key] = (counts.by_agent_type[key] || 0) + value;
    } catch { /* the folders keep their last counts */ }
    await loadUnread();
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
        if (!inboxSources().length) throw new Error('No computers online.'); // a Hub with none linked or none online: say so, not "No chats"
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
/** Forget the kept lists: all of them, or only a folder's (a search sent on Enter reads that folder again, though the same words were read before: the Hub-served Inbox, #9574). The key is `sources|folder|words|filters`. */
export function resetChatLists(folder) { if (!folder) { lists.clear(); return; } for (const k of [...lists.keys()]) if (k.split('|')[1] === folder) lists.delete(k); }

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
const name = (s) => (isGroup(s) ? (s.title || String(s.session_id).replace(/^board:/, '')) : (s.display_name || s.agent_name || ''));

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

const chatState = DT.tableState(); // the chats the person has selected on a phone (an avatar tap): kept across the redraws of a folder
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
        signature: JSON.stringify([key, q, extra, folderCount(key), L.busy, L.done, L.error, rows.map(s => [s.server, s.session_id, s.title, s.summary, stampOf(s), s.starred, s.archived, s.active, s.duration_sec, IR.isUnread(readKind(s), readKey(s), stampOf(s))])]),
        node: () => { const table = DT.dataTable({ label: `${folder.title}, ${folderCount(key) ?? rows.length}`, rows, rowKey: s => `${s.server}:${s.session_id}`, state: chatState,
            onModeChange: () => ctx.redraw?.(), // the window crossed 767 px: this spec's selectable (phone only) is decided at draw, so the owner draws the table again
            selectable: isCloud() || !window.matchMedia?.('(max-width: 767px)').matches ? null : { contextKey: key, canSelect: s => !isGroup(s) && (!s.server || s.server === 'local'), onChange: keys => ctx.selection?.(keys.size ? table.bar : null),
                actions: [{ label: 'Star', run: async rows => { for (const s of rows) await setChatFlag(s.session_id, 'starred', true, s.server); chatState.selected.clear(); ctx.after(); } }, { label: 'Archive', run: async rows => { for (const s of rows) await setChatFlag(s.session_id, 'archived', true, s.server); chatState.selected.clear(); ctx.after(); } }] }, // select by the avatar on a phone, then Star or Archive (the flags route: this computer's chats only) rowName: s => name(s) || historyLabel(s),
            groupBy: s => ({ key: dayOf(stampOf(s)), label: dayOf(stampOf(s)) }),
            open: s => ctx.open(s),
            unread: s => IR.isUnread(readKind(s), readKey(s), stampOf(s)),
            mail: s => { const group = isGroup(s), who = name(s) || (group ? 'Board' : historyLabel(s)); return { unread: IR.isUnread(readKind(s), readKey(s), stampOf(s)), lead: { text: who, name: who, square: group }, title: who, snippet: group ? '' : historyLabel(s), time: DT.shortTime(stampOf(s)) }; }, // a phone's row: the agent or board, the chat's title after it, the time
            footer: (L.done && !L.error) ? undefined : { text: L.error || (L.done ? '' : (L.total != null ? `Showing ${rows.length} of ${L.total}` : '')), auto: !L.done && !L.error, more: L.done ? null : { label: 'Load more', busy: L.busy, run: () => readMore(key, folder, q, extra, ctx.redraw) } },
            oneLine: true, resize: false, sortBar: false, // one line per chat, never folded (#8961, the shared one-row table of #8931): Server, then Agent drop as the box narrows; the role and the first message are in the chat that opens
            columns: [
                { key: 'title', label: key === 'chats-group' ? 'Board' : 'Title', primary: true, width: 'grow', cell: s => { const group = isGroup(s), n = group ? (name(s) || 'Board') : historyLabel(s), who = group ? '' : name(s); const b = DT.primaryButton(n, group ? `Open the chat of the board ${n}` : `Open the chat ${n}${who ? ` of ${who}` : ''}`); b.dataset.sessionId = s.session_id; if (multipleServers()) b.title = `${n} · ${serverLabel(serverOf(s))}`; // the Server column goes first on a narrow row (#8961): the computer stays on the hover
                    const marks = []; if (group) marks.push(DT.tag('Board')); if (s.active) marks.push(DT.tag('Active now')); /* an archived board stays in Board history, marked */ if (s.archived && key !== 'chats-archived') marks.push(DT.tag('Archived'));
                    if (!marks.length) return b; const w = DT.el('span', 'dt-title-cell'); w.append(b, ...marks); return w; } },
                ...(key === 'chats-group' ? [] : [{ key: 'agent', label: 'Agent', width: '9rem', dropAt: 36, cell: s => name(s) }]),
                { key: 'when', label: 'When', tone: 'tertiary', align: 'end', width: '7.5rem', cell: s => DT.timeCell(stampOf(s)) },
                ...serverColumns().map(c => ({ ...c, line: undefined, sort: false, width: '7rem', dropAt: 52 })),
                { key: 'flags', label: 'Star and archive', hideLabel: true, width: '6.5rem', dropAt: 36, /* the two icon buttons are about 100 px: at 5 rem the second was cut by the table's edge, a stray mark (#9458) */ cell: s => {
                    if (isCloud() || (s.server && s.server !== 'local')) return '';
                    const w = DT.el('span', 'dt-chat-flags');
                    // icon buttons that show on the row's hover or focus (the star stays drawn when set); a phone has them in the opened chat
                    const flag = (key, on, icon, label, pressed) => { const b = DT.el('button', `dt-flag${key === 'starred' && on ? ' dt-flag-on' : ''}`); b.type = 'button'; b.title = label; b.setAttribute('aria-label', `${label}: ${name(s) || historyLabel(s)}`); if (pressed) b.setAttribute('aria-pressed', String(!!on)); const i = DT.el('span', 'material-icons', icon); i.setAttribute('aria-hidden', 'true'); b.append(i); b.addEventListener('click', (e) => { e.stopPropagation(); setFlag(s, key, !on, ctx.after); }); return b; };
                    w.append(flag('starred', s.starred, 'star', s.starred ? 'Remove the star' : 'Star', true), flag('archived', s.archived, s.archived ? 'unarchive' : 'archive', s.archived ? 'Unarchive' : 'Archive', false)); return w; } },
            ] }); ctx.selection?.(chatState.selected.size ? table.bar : null); return table.el; } };
}
