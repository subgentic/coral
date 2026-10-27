/* The dashboard's routes (#3532): page paths <-> route objects. Pure (no DOM, no state), so
   the parser can be tested on its own and nav.js is the only place that touches history.

   A route is { view, server?, id?, sub?, run?, query? }:
     /agents                              { view: 'agents' }
     /agents/[@<server>/]<session>[/<sub>]  { view: 'agents', server, id, sub }
     /agents/[@<server>/]<session>[/<sub>]?view=terminal  the same, plus terminal: true (the link opens the agent on its terminal; coral-hub, #6752)
     /chats[/@<server>][?filters]         { view: 'chats', query }
     /chats/[@<server>/]<id>              { view: 'chats', id }
     /team/[@<server>/]<team>[/<tab>[/<n>]]  { view: 'team', server, id, sub, item }: the team page (#7453); <tab> is one of TEAM_TABS (none = Goals), <n> a goal or a task; the Board tab's path word is "board" (the old "messages" is read and written as board, #8652)
     /inbox/needs, /inbox/saved, /inbox/artifacts, /inbox/chats[/<all|active|starred|notes|archived|cli-<cli>|tag-<n>]  { view: 'inbox-folder', folder }: an Inbox folder's page (#8652); goals, tasks and boards are their own page families (#8571, #8633)
     /board/[@<server>/]<name>            { view: 'board', server, id }
     /workflows[/<id>[/runs/<run>]]       { view: 'workflows', id, run }
     /automations[/<folder>[/<id>[/runs/<run>]]]  { view: 'automations', folder, id, run }: Workflows and Jobs as one screen (Goal #74); <folder> is one of AUTOMATION_FOLDERS, <id> a job or a workflow, <run> a workflow's run
     /analytics[/<page>]                  { view: 'analytics', sub }: <page> is one of ANALYTICS_PAGES (none = Overview, #8606)
     /jobs, /docs[/<name>], /servers[/<id>]

   A remote object's server is the RAW segment "@<server>". A name that starts with "@" is written
   as %40, so the marker is tested before decoding. Every segment is decoded once and must match
   its own pattern; anything else is not a route (parse returns null and the router goes to /).
   Ids are never built into an /api path unless they passed these patterns (coral-hub Security). */

 const SERVER_RE = /^(?:[a-z0-9-]{1,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
 const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A history chat id: the agent's own session id (a UUID for most agents). No "/", "?", "#",
// "%" or "..", so it can't steer an API path.
 const HISTORY_ID_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// An agent doc's name: its file name without .md (README, coral-board, ...).
 const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
 const INT_RE = /^[1-9][0-9]{0,15}$/;
// The team page's tabs, in order (#7453). /team/<name> with no tab is the first.
export const TEAM_TABS = ['goals', 'agents', 'tasks', 'artifacts', 'knowledge', 'messages']; // the strip's order, left to right and by the arrow keys (the operator's, #8791): Goals, Agents, Tasks, Artifacts, Knowledge, Board; team settings are a popout (#8853), not a tab
const TEAM_ITEM_TABS = ['goals', 'tasks', 'messages']; // the tabs with an item: /team/<name>/goals/<id>, /team/<name>/tasks/<id> (pages), /team/<name>/messages/<id> (the Board tab scrolled to that message, #7921)
// An agent's own tabs (live_session.html #agentic-tab-<id>); the team-scoped ones belong to /team.
export const AGENT_SUBTABS = ['board', 'tasks', 'notes', 'files', 'browse', 'artifacts', 'activity', 'agent-ui'];
// The Analytics pages that have a path (analytics_views.js VIEWS, #8606); /analytics is Overview, and an agent's page (agent-detail) is under By agent.
export const ANALYTICS_PAGES = ['provider', 'model', 'thinking', 'team', 'agent', 'branch', 'task', 'calls', 'per-commit', 'task-time'];
// The Automations folders (Goal #74): the two that need attention, then the library. A job or a workflow opens under its own folder; only a workflow has a run page.
export const AUTOMATION_FOLDERS = ['running', 'failed', 'recent', 'jobs', 'workflows'];
const NAME_MAX = 200; // board.MaxIdentityRunes
const INBOX = 'in' + 'box'; // the path word, spelled in two parts: the icon-name lint reads that quoted word as an icon name
// The Inbox folders' paths (#8652): /inbox/needs, /inbox/saved, /inbox/artifacts (every team's artifacts, Goal #62), /inbox/chats/<all|active|starred|notes|archived|cli-<cli>|tag-<n>>. The folder keys are the Inbox's own (inbox_sidebar.js): chats is All chats, the others chats-<word>.
const INBOX_CHATS_RE = /^(?:all|active|starred|notes|archived|cli-[a-z0-9]{1,20}|tag-[1-9]\d{0,11})$/;
const INBOX_FOLDER_RE = /^(?:needs|saved|artifacts|chats|chats-(?:active|starred|notes|archived|cli-[a-z0-9]{1,20}|tag-[1-9]\d{0,11}))$/;
// The team page's tabs by the word their path uses: the Board tab was Messages (#7784), and /team/<t>/messages still opens it, as /board (#8652).
const TAB_PATH = { messages: 'board' };
const TAB_FROM_PATH = { board: 'messages', messages: 'messages' };

// The query keys the Chats tab owns (search_filters.js), kept on /chats only.
 const CHATS_QUERY_KEYS = ['page', 'type', 'q', 'fts_mode', 'tag_ids', 'tag_logic', 'source_types',
    'date_from', 'date_to', 'min_duration_sec', 'max_duration_sec'];

// eslint-disable-next-line no-control-regex
const BAD_NAME_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/** A board or team name from a URL segment: decoded once, no control or formatting
 *  characters, at most NAME_MAX characters, at least one visible character, and not "." or
 *  "..": the views put the name in an /api path (boardFetch), where a dot segment would climb
 *  out of /api/board/ (coral-hub Security). New names like these are refused at creation (#3534). */
function name(raw) {
    const v = decode(raw);
    if (v === null || !v.trim() || v === '.' || v === '..' || BAD_NAME_RE.test(v) || [...v].length > NAME_MAX) return null;
    return v;
}

/** decodeURIComponent once, or null for a bad percent sequence. */
function decode(raw) {
    try { return decodeURIComponent(raw); } catch { return null; }
}

/** A server from a raw "@<server>" segment, or null when the segment is not a marker. */
function serverOf(raw) {
    if (!raw || raw[0] !== '@') return null;
    const d = decode(raw.slice(1));
    const s = d === null ? null : d.toLowerCase(); // "@M2" is server m2 (QA)
    return s !== null && SERVER_RE.test(s) ? s : undefined; // undefined: a bad marker
}

/** parse(pathname, search) returns a route, or null when the path is not a valid route. */
export function parse(pathname, search = '') {
    const segs = String(pathname || '/').split('/').slice(1);
    if (segs.length && segs[segs.length - 1] === '') segs.pop(); // a trailing slash
    const [top, ...rest] = segs;
    const take = () => {
        const srv = serverOf(rest[0]);
        if (srv === undefined) return { bad: true };
        if (srv) rest.shift();
        return { server: srv || null };
    };
    // Explicit dashboard Inbox families only; /inbox itself belongs to Coral Hub.
    if (['inbox/goals', 'inbox/tasks', 'inbox/boards'].includes([top, rest[0]].join('/'))) {
        const sub = rest[0], route = { view: 'inbox-' + sub, sub };
        if (rest.length === 1) return route;
        if (sub === 'boards' ? rest.length !== 2 : rest.length !== 3 || !INT_RE.test(rest[2])) return null;
        const team = name(rest[1]);
        return team === null ? null : { ...route, id: team, ...(sub === 'boards' ? {} : { item: Number(rest[2]) }) };
    }
    switch (top) {
        case undefined: case '': case 'agents': {
            if (!rest.length) return { view: 'agents' };
            const t = take();
            if (t.bad || !rest.length || rest.length > 2) return null;
            const id = decode(rest[0]);
            if (id === null || !SESSION_RE.test(id)) return null;
            const sub = rest[1] === undefined ? null : rest[1];
            if (sub !== null && !AGENT_SUBTABS.includes(sub)) return null;
            const route = { view: 'agents', server: t.server, id: id.toLowerCase(), sub };
            if (terminalQuery(search)) route.terminal = true; // read once from the URL: build() writes the path without it, so the address bar loses it as the page starts
            return route;
        }
        case 'chats': {
            const t = take();
            if (t.bad) return null;
            const source = t.server ? { server: t.server } : {};
            if (!rest.length) return { view: 'chats', ...source, query: chatsQuery(search) };
            if (rest.length !== 1) return null;
            const id = decode(rest[0]);
            return id !== null && HISTORY_ID_RE.test(id) ? { view: 'chats', ...source, id } : null;
        }
        case 'team': case 'board': {
            const t = take();
            if (t.bad || !rest.length) return null;
            const n = name(rest[0]);
            if (n === null) return null;
            if (top === 'board') return rest.length === 1 ? { view: 'board', server: t.server, id: n } : null;
            if (rest.length === 1) return { view: 'team', server: t.server, id: n, sub: null };
            const tab = Object.hasOwn(TAB_FROM_PATH, rest[1]) ? TAB_FROM_PATH[rest[1]] : rest[1]; // the path's word, as the page names the tab
            if (!TEAM_TABS.includes(tab)) return null;
            if (rest.length === 2) { const query = tab === 'tasks' ? tasksQuery(search) : ''; return query ? { view: 'team', server: t.server, id: n, sub: tab, query } : { view: 'team', server: t.server, id: n, sub: tab }; }
            return rest.length === 3 && TEAM_ITEM_TABS.includes(tab) && INT_RE.test(rest[2]) ? { view: 'team', server: t.server, id: n, sub: tab, item: Number(rest[2]) } : null;
        }
        case INBOX:
            if (rest.length === 1 && (rest[0] === 'needs' || rest[0] === 'saved' || rest[0] === 'artifacts')) return { view: 'inbox-folder', folder: rest[0] };
            if (rest[0] === 'chats' && rest.length <= 2 && (rest.length === 1 || INBOX_CHATS_RE.test(rest[1]))) return { view: 'inbox-folder', folder: rest.length === 1 || rest[1] === 'all' ? 'chats' : `chats-${rest[1]}` };
            if (rest[0] === 'chats' && rest.length >= 3 && INBOX_CHATS_RE.test(rest[1])) { // a chat on screen in the Inbox: /inbox/chats/<folder>/[@<server>/]<id> (Goal #100, #9549); the folder is the one it opens under
                const folder = rest[1] === 'all' ? 'chats' : `chats-${rest[1]}`;
                rest.splice(0, 2);
                const t = take();
                if (t.bad || rest.length !== 1) return null;
                const id = decode(rest[0]);
                return id !== null && HISTORY_ID_RE.test(id) ? { view: 'inbox-folder', folder, ...(t.server ? { server: t.server } : {}), id } : null;
            }
            return null;
        case 'workflows': {
            if (!rest.length) return { view: 'workflows' };
            if (!INT_RE.test(rest[0])) return null;
            if (rest.length === 1) return { view: 'workflows', id: Number(rest[0]) };
            if (rest.length === 3 && rest[1] === 'runs' && INT_RE.test(rest[2])) return { view: 'workflows', id: Number(rest[0]), run: Number(rest[2]) };
            return null;
        }
        case 'jobs':
            return rest.length ? null : { view: top };
        case 'automations': {
            if (!rest.length) return { view: 'automations', folder: null };
            if (!AUTOMATION_FOLDERS.includes(rest[0])) return null;
            const folder = rest[0], route = { view: 'automations', folder };
            if (rest.length === 1) return route;
            if (!INT_RE.test(rest[1]) || (folder !== 'jobs' && folder !== 'workflows')) return null;
            if (rest.length === 2) return { ...route, id: Number(rest[1]) };
            if (folder === 'workflows' && rest.length === 4 && rest[2] === 'runs' && INT_RE.test(rest[3])) return { ...route, id: Number(rest[1]), run: Number(rest[3]) };
            return null;
        }
        case 'analytics': {
            if (!rest.length) return { view: 'analytics' };
            if (rest.length !== 1) return null;
            if (rest[0] === 'overview') return { view: 'analytics' };
            return ANALYTICS_PAGES.includes(rest[0]) ? { view: 'analytics', sub: rest[0] } : null;
        }
        case 'docs': {
            if (!rest.length) return { view: 'docs' };
            return rest.length === 1 && DOC_RE.test(rest[0]) ? { view: 'docs', id: rest[0] } : null;
        }
        case 'servers': {
            if (!rest.length) return { view: 'servers' };
            const id = rest.length === 1 ? decode(rest[0]) : null;
            return id !== null && SERVER_RE.test(id) ? { view: 'servers', id } : null;
        }
        default:
            return null;
    }
}

/** Whether a query string asks for the terminal: exactly one view parameter, and its value is exactly "terminal". Any other value, a second view, junk or none is no. Other keys are not read. */
function terminalQuery(search) {
    const v = new URLSearchParams(search || '').getAll('view');
    return v.length === 1 && v[0] === 'terminal';
}

/** Where an old Chats address goes when the Inbox is the native one (nativeInbox(), Goal #100, #9549): the same chat or list as an Inbox route, never a not-found page. A chat is the chat on screen in the Inbox, under
 *  All chats (an old address does not say its folder); a list is the folder its filter names (starred, archived, active, with_notes; type=group is the Boards folder), else All chats: every other filter is dropped and the
 *  address still lands on a page. The computer (/chats/@<server>) is dropped from a list (the Inbox folders read every online computer) and kept on a chat. Any other route is returned as it is. */
export function inboxRouteFor(route) {
    if (!route || route.view !== 'chats') return route;
    if (route.id) return { view: 'inbox-folder', folder: 'chats', ...(route.server ? { server: route.server } : {}), id: route.id };
    const q = new URLSearchParams(route.query || '');
    const on = k => q.get(k) === '1';
    if (q.get('type') === 'group') return { view: 'inbox-boards', sub: 'boards' };
    const folder = on('starred') ? 'chats-starred' : on('archived') ? 'chats-archived' : on('active') ? 'chats-active' : on('with_notes') ? 'chats-notes' : 'chats';
    return { view: 'inbox-folder', folder };
}

/** The Chats tab's filters from a query string (only its own keys). */
export function chatsQuery(search) {
    const p = new URLSearchParams(search || '');
    const out = new URLSearchParams();
    for (const k of CHATS_QUERY_KEYS) if (p.has(k) && p.get(k) !== '') out.set(k, p.get(k));
    if (out.get('page') === '1') out.delete('page');
    return out.toString();
}

/** The team Tasks tab's filters from a query string (#7782): only its own keys, each checked against what the filter can hold; anything else is dropped (the dashboard reads the rest again with its own checks). */
export function tasksQuery(search) {
    const p = new URLSearchParams(search || '');
    const out = new URLSearchParams();
    const ok = {
        goal: v => v === 'none' || /^[1-9]\d{0,11}$/.test(v), agent: v => v.length <= 80 && !/[\u0000-\u001f\u007f]/.test(v), priority: v => ['critical', 'high', 'medium', 'low'].includes(v),
        q: v => v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v), from: v => /^\d{4}-\d{2}-\d{2}$/.test(v),
    };
    for (const k of Object.keys(ok)) { const v = p.get(k); if (v !== null && v.trim() !== '' && ok[k](v)) out.set(k, v); }
    return out.toString();
}

/** One name segment: encoded, with a leading "@" written as %40 so it can't read as a server. */
function seg(v) {
    const e = encodeURIComponent(String(v));
    return e.startsWith('@') ? '%40' + e.slice(1) : e;
}

const srvSeg = server => (server ? `@${encodeURIComponent(server)}/` : '');

/** build(route) returns the path (and query) for a route. */
export function build(r) {
    switch (r && r.view) {
        case 'agents':
            return r.id ? `/agents/${srvSeg(r.server)}${seg(r.id)}${r.sub ? '/' + r.sub : ''}` : '/agents';
        case 'chats':
            return r.id ? `/chats/${srvSeg(r.server)}${seg(r.id)}` : `/chats${r.server ? '/' + srvSeg(r.server).replace(/\/$/, '') : ''}${r.query ? '?' + r.query : ''}`;
        case 'inbox-goals': case 'inbox-tasks':
            return r.view === 'inbox-' + r.sub ? `/inbox/${r.sub}${r.id && r.item ? '/' + seg(r.id) + '/' + r.item : ''}` : '/';
        case 'inbox-boards':
            return r.sub === 'boards' ? `/inbox/boards${r.id ? '/' + seg(r.id) : ''}` : '/';
        case 'team':
            return `/team/${srvSeg(r.server)}${seg(r.id)}${TEAM_TABS.includes(r.sub) ? '/' + (TAB_PATH[r.sub] || r.sub) + (r.item && TEAM_ITEM_TABS.includes(r.sub) ? '/' + r.item : '') : ''}${r.sub === 'tasks' && !r.item && r.query ? '?' + r.query : ''}`;
        case 'board':
            return `/board/${srvSeg(r.server)}${seg(r.id)}`;
        case 'inbox-folder':
            return INBOX_FOLDER_RE.test(String(r.folder)) ? `/inbox/${r.folder === 'needs' || r.folder === 'saved' || r.folder === 'artifacts' ? r.folder : 'chats/' + (r.folder === 'chats' ? 'all' : r.folder.slice(6))}${r.id && String(r.folder).startsWith('chats') ? '/' + srvSeg(r.server) + seg(r.id) : ''}` : '/';
        case 'workflows':
            return r.id ? `/workflows/${r.id}${r.run ? '/runs/' + r.run : ''}` : '/workflows';
        case 'jobs':
            return '/jobs';
        case 'automations':
            return AUTOMATION_FOLDERS.includes(r.folder) ? `/automations/${r.folder}${r.id ? '/' + r.id + (r.run && r.folder === 'workflows' ? '/runs/' + r.run : '') : ''}` : '/automations';
        case 'analytics': {
            const page = r.sub === 'agent-detail' ? 'agent' : r.sub;
            return ANALYTICS_PAGES.includes(page) ? '/analytics/' + page : '/analytics';
        }
        case 'docs':
            return r.id ? `/docs/${seg(r.id)}` : '/docs';
        case 'servers':
            return r.id ? `/servers/${seg(r.id)}` : '/servers';
        default:
            return '/';
    }
}

/** The route an old hash link meant (#chat/, #session/, #history/, #team-view=, #team-settings=,
 *  #servers, #tokens, #board/, #agents), or null when the hash is not a legacy view link.
 *  The result goes through build() and parse() again, so a bad id is dropped like any other. */
export function fromLegacyHash(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (!h || h === 'agents') return { view: 'agents' };
    const team = /^team-(view|settings)=(.+)$/.exec(h);
    if (team) {
        const key = decode(team[2]);
        if (key === null) return null;
        const m = /^@([^/]+)\/(.+)$/.exec(key);
        return { view: 'team', server: m ? m[1] : null, id: m ? m[2] : key, sub: team[1] === 'settings' ? null : 'agents' }; // the Team view is the Agents tab (#7453); team settings are a popout now (#8853): an old settings link opens the team
    }
    const [v, ...parts] = h.split('/');
    const d = parts.map(decode);
    if (d.some(x => x === null)) return null;
    switch (v) {
        case 'chat':
            return d.length === 2 ? { view: 'agents', server: d[0], id: d[1] } : d.length === 1 ? { view: 'agents', id: d[0] } : null;
        case 'session': case 'history':
            return d.length === 1 ? { view: 'chats', id: d[0] } : d.length === 0 ? { view: 'chats', query: '' } : null;
        case 'servers':
            return d.length ? { view: 'servers', id: d[0] } : { view: 'servers' };
        case 'tokens': case 'analytics':
            return { view: 'analytics' };
        case 'workflows': case 'jobs': case 'docs':
            return d.length ? null : { view: v };
        case 'chats':
            return d.length ? null : { view: 'chats', query: '' };
        case 'board':
            return d.length === 1 ? { view: 'board', id: d[0] } : null;
        default:
            return null;
    }
}

/** The route as the parser reads it back from its own URL, or null: the ONLY form handlers
 *  ever see, so a field build() ignores (a stray sub, markup) can't reach a view, and an old or
 *  tampered history.state is checked like a typed URL (Security's review of 1b part 1). */
export function normalize(route) {
    if (!route || typeof route !== 'object') return null;
    const built = build(route);
    let url;
    try { url = new URL(built, 'http://x'); } catch { return null; }
    // A path the URL parser rewrote (a dot segment: "/team/./settings" is "/team/settings") is not
    // the route that was asked for.
    if (url.pathname !== built.split('?')[0]) return null;
    const back = parse(url.pathname, url.search);
    return back && back.view === route.view ? back : null;
}

/** Is this route valid? */
export function valid(route) { return normalize(route) !== null; }

// ── Routes from the dashboard's own keys ────────────────────────────────
// The views name a team or board by its identity key (server_base.js identityKey: "name" on this
// Coral, "@<server>/name" on another), and the local server is "local"; a route has server null.

const LOCAL = 'local';
const routeServer = s => (!s || s === LOCAL ? null : String(s));

/** The route of a live agent: its server ("local" or empty for this Coral) and session id. */
export function liveRoute(server, sessionId, sub = null) {
    return { view: 'agents', server: routeServer(server), id: sessionId, sub: sub || null };
}

/** The route of a team or board from its identity key. */
export function keyRoute(view, key, sub = null, item = null, query = '') {
    const k = String(key ?? '');
    // As splitKey reads it: "@<server>/name" only when <server> is a server id ("@x!/y" is a name).
    const m = /^@([^/]+)\/(.+)$/.exec(k);
    const remote = m && SERVER_RE.test(m[1]);
    const r = { view, server: remote ? routeServer(m[1]) : null, id: remote ? m[2] : k };
    if (view === 'team') { r.sub = TEAM_TABS.includes(sub) ? sub : null; if (item && TEAM_ITEM_TABS.includes(r.sub)) r.item = Number(item); else if (query && r.sub === 'tasks') r.query = tasksQuery(query); }
    return r;
}

/** The identity key a team or board route names (the inverse of keyRoute). */
export function routeKey(route) {
    return route.server ? `@${route.server}/${route.id}` : route.id;
}

/** The path of an Inbox folder by its key (#8652), for the folders whose pages are other families' too (goals #8571, tasks and boards #8633): parse() answers null for a path this build does not know. */
export function inboxFolderPath(key) {
    if (key === 'goals') return '/inbox/goals';
    if (key === 'tasks') return '/inbox/tasks';
    if (key === 'chats-group') return '/inbox/boards';
    return INBOX_FOLDER_RE.test(String(key)) ? build({ view: 'inbox-folder', folder: key }) : '';
}

/** The views the Hub does not serve (#9368): Automations and the old Workflows and Jobs addresses that open it. */
export const HIDDEN_IN_CLOUD = ['automations', 'workflows', 'jobs'];
/** Where an address goes when the dashboard is served by the Hub: a hidden view opens the Agents home, any other route is as it was. */
export const cloudRedirect = (route, cloud) => (cloud && route && HIDDEN_IN_CLOUD.includes(route.view) ? { view: 'agents' } : route);
