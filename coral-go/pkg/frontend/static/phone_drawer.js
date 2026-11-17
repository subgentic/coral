/* The phone's ☰ drawer (#11472, Gmail's): a left drawer of OPTIONS in the current context, never the list of tabs (the bottom bar has those). The top of it is, from the Inbox or Chats, the Inbox's folders with their counts at the right
 * (Needs you, Tasks, Saved, Chats) and the teams; from every other screen Tasks and Chats (the bar has neither, #11535) and, from Agents, All agents and the teams; below a divider (nav_tabs.js adds them) are the less-used places: Docs, Computers, Settings, Themes, Check for updates (Automations and Analytics are bar tabs). It is the one
 * menu (#nav-more-menu) drawn as a panel: this file builds what is above the divider and the scrim behind it; css/mobile.css draws both. */
import { state } from './state.js';
import { importOnce, loadedModule } from './import_once.js';
import { inboxCountsNow } from './inbox_tab.js';
import { identityKey, sessionServer, serverFetch } from './server_base.js';
import { teamLabel } from './server_status.js';
import { el } from './dom_el.js';


const heading = (cls, words) => { const h = el('div', cls, words); h.setAttribute('role', 'presentation'); return h; };
function countWords(label, count, { unread = false, noun: explicitNoun, words } = {}) {
    if (words) return words;
    if (unread) return `${count} unread`;
    if (label === 'Needs you') {
        const split = String(count).match(/^(\d+) of (\d+)$/);
        return split ? `${split[1]} waiting out of ${split[2]} items` : `${count} waiting`;
    }
    // Task rows reflect the current filters; Goals includes pending proposals; Saved counts open saved items and files.
    const noun = explicitNoun || { Tasks: 'task', Goals: 'goal or proposal', Saved: 'saved item', Artifacts: 'file', 'All agents': 'agent' }[label];
    if (!noun) return String(count);
    if (label === 'Goals' && !explicitNoun) return `${count} ${Number(count) === 1 ? 'goal or proposal' : 'goals or proposals'}`;
    return `${count} ${noun}${Number(count) === 1 ? '' : 's'}`;
}

/** The glyph of a drawer row: the one the desktop sidebar draws for the folder (view_list.js), not a stand-in: Saved's bookmark, a CLI's letter badge, the archive box of Artifacts; any other name is a Material icon (#19082 item 3). */
function folderGlyph(icon) {
    let i;
    if (icon === 'saved-bookmark') {
        i = el('span', 'view-list-icon'); i.style.cssText = 'display:inline-grid;place-items:center;width:1.25rem;height:1.25rem'; const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M4 2.5h8v11L8 10.5l-4 3z'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.append(path); i.append(svg);
    } else if (String(icon).startsWith('cli:')) {
        const type = icon.slice(4), mark = loadedModule('./agent_marks.js')?.markOf?.(type) || '';
        i = el('span', 'view-list-icon agent-type-mark'); i.dataset.agentType = type; if (mark) i.dataset.mark = mark;
    } else i = el('span', 'material-icons', icon);
    i.setAttribute('aria-hidden', 'true');
    return i;
}

function row(icon, label, count, run, current = false, countContext = {}) {
    const b = el('button', 'menu-item nav-more-item nav-drawer-folder'); b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (current) { b.setAttribute('aria-current', 'true'); b.classList.add('is-current'); } // the open folder: marked by weight and a bar, and said in words
    const i = folderGlyph(icon);
    b.append(i, el('span', 'nav-drawer-label', label));
    if (typeof count === 'string' && count) b.append(el('span', 'nav-drawer-count', count)); // Needs you says '0 of 3'
    else if (count > 0 || (count === 0 && countContext.known)) b.append(el('span', 'nav-drawer-count', count > 99 && !countContext.known ? '99+' : String(count)));
    if ((typeof count === 'string' && count) || count > 0 || (count === 0 && (label === 'Needs you' || countContext.known))) b.setAttribute('aria-label', `${label}, ${countWords(label, count, countContext)}`);
    b.querySelector('.nav-drawer-count')?.setAttribute('aria-hidden', 'true'); // the full contextual count is in the item's accessible name
    b.addEventListener('click', run);
    return b;
}

const slot = name => () => document.querySelector(`.phone-nav-slot[data-phone-nav=${name}]`)?.click(); // the bar's own handler: the same page, the same lit tab
const inboxPage = (page, words) => () => { window.switchNavTab?.('hub-inbox'); importOnce('./inbox_tab.js').then(m => m.selectInboxTab(page)).then(() => importOnce('./phone_bar.js')).then(p => p.setPhonePageName(words)); }; // Tasks and Chats have no bar slot: the Inbox's page, named in the pill (#11401, #11535)

// The teams: on a hub every team of this computer and of each online computer (GET /api/board/projects, as analytics_spend.js), else this computer's; read when the drawer opens and at most every 30 s; until the read
// answers the drawer shows the teams of the live agents (#11476).
const boards = { keys: [], at: 0, sig: '', reading: null };
function readTeamKeys() {
    const servers = ['local', ...(state.hub ? (state.servers || []).filter(x => x && x.id && x.id !== 'local' && x.status === 'online').map(x => x.id) : [])], sig = servers.join();
    if (boards.reading || (sig === boards.sig && Date.now() - boards.at < 30000)) return boards.reading || Promise.resolve(false);
    boards.reading = Promise.all(servers.map(async server => {
        try {
            const r = await serverFetch(server, '/api/board/projects');
            const rows = r.ok ? await r.json() : [];
            return Array.isArray(rows) ? rows.filter(x => x && x.board_id).map(x => identityKey(server, x.board_id)) : [];
        } catch { return []; }
    })).then(lists => { boards.keys = [...new Set(lists.flat())].sort(); boards.at = Date.now(); boards.sig = sig; boards.reading = null; return true; });
    return boards.reading;
}
const liveTeamKeys = () => [...new Set((state.liveSessions || []).filter(s => s && s.board_project).map(s => identityKey(sessionServer(s), s.board_project)))];
const FEW_TEAMS = 4; // up to this many teams are all listed, as active_teams.js does: its module is not even loaded for them
// The same rule as the agent list's (active_teams.js, #15744): active teams first, newest message first, the idle ones behind Show all teams (n idle), the open team always listed (#18744).
function drawTeams(host) {
    const keys = boards.keys.length ? boards.keys : liveTeamKeys();
    const of = k => (state.liveSessions || []).filter(s => s && s.board_project && identityKey(sessionServer(s), s.board_project) === k);
    let shown = keys.map(k => [k, of(k)]);
    if (shown.length > FEW_TEAMS) {
        const AT = loadedModule('./active_teams.js');
        if (AT) shown = AT.pick(shown);
        else importOnce('./active_teams.js').then(() => { if (host.isConnected) drawTeams(host); }).catch(() => {});
    }
    const rows = shown.map(([k, list]) => row('group', teamLabel(k), list.length, () => window.openTeamPage?.(k), false, { noun: 'agent' }));
    if (shown.idle) { // the row under the teams: the choice is the list's own, remembered in this browser
        const b = row('expand_more', shown.hide ? `Show all teams (${shown.idle} idle)` : 'Show active teams only', 0, e => { e.stopPropagation(); loadedModule('./active_teams.js')?.toggleShowAll(); drawTeams(host); host.querySelector('.nav-drawer-teams-all')?.focus(); }); // the drawer stays open for it (a choice closes it: nav_tabs.js)
        b.classList.add('nav-drawer-teams-all'); b.setAttribute('aria-expanded', shown.hide ? 'false' : 'true');
        rows.push(b);
    }
    host.replaceChildren(...(keys.length ? [heading('nav-drawer-group', 'Teams'), ...rows] : []));
}

/** The context the drawer opens from: the open tab's own options come first (the Inbox's folders; Agents' teams), the rest of the places are below the divider. */
const contextOf = () => document.querySelector('.top-nav-tab.active')?.dataset.arg || '';

/** The nodes above the divider: the heading, then what belongs to the screen it opened from. */
export function drawerTop() {
    const ctx = contextOf();
    const out = [heading('nav-drawer-head', 'Coral')];
    if (ctx === 'hub-inbox' || ctx === 'history') { // the Inbox, its Tasks and Chats: the Inbox's folders with their counts
        const rows = state.inboxFolderRows?.(); // every folder of the Inbox, as its sidebar lists them (#13596: a phone has no tab strip)
        if (rows) {
            for (const sec of rows.sections) {
                if (sec.title && rows.sections.length > 1) out.push(heading('nav-drawer-group', sec.title));
                for (const it of sec.items) {
                    const total = it.unread && it.count == null ? it.total : null;
                    out.push(row(/^[a-z0-9_:-]+$/.test(it.icon || '') ? it.icon : 'folder', it.label, total ?? it.count, () => { window.switchNavTab?.('hub-inbox'); importOnce('./inbox_tab.js').then(() => rows.pick(it.key)); }, it.key === rows.current, { unread: it.unread && total == null, known: true, noun: it.unread ? 'chat' : undefined, words: it.words }));
                }
            }
        } else {
            const c = inboxCountsNow();
            out.push(row('email', 'Needs you', c.needs, slot('nav-inbox')), row('checklist', 'Tasks', c.tasks, inboxPage('tasks', 'Tasks')),
                row('star', 'Saved', c.saved, () => { window.switchNavTab?.('hub-inbox'); importOnce('./inbox_tab.js').then(m => m.selectInboxTab('saved')); }), row('chat_bubble_outline', 'Chats', 0, inboxPage('chats', 'Chats')));
        }
    } else {
        if (ctx === 'agents') out.push(row('smart_toy', 'All agents', (state.liveSessions || []).length, () => window.switchNavTab?.('agents')));
        out.push(row('checklist', 'Tasks', inboxCountsNow().tasks, inboxPage('tasks', 'Tasks')), row('chat_bubble_outline', 'Chats', 0, inboxPage('chats', 'Chats'))); // the bar has no Tasks or Chats: every other drawer has them first
    }
    if ((state.liveSessions || []).length) {
        out.push(row('timeline', 'Activity', 0, () => { const s = state.currentSession || (state.liveSessions || [])[0]; if (!s) return; window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id, sessionServer(s))).then(() => { window.switchAgenticTab?.('activity', 'top'); window.toggleAgenticPanel?.(true); }); }));
    }
    if (ctx === 'hub-inbox' || ctx === 'history' || ctx === 'agents') { // teams belong with agents and with the Inbox; an Automations, Analytics or Docs drawer is its places only
        const host = el('div', 'nav-drawer-teams'); drawTeams(host); out.push(host);
        readTeamKeys().then(() => { if (host.isConnected) drawTeams(host); });
    }
    return out;
}

/** The scrim behind the open drawer: a tap on it closes it. */
export function showScrim(close) {
    if (document.getElementById('nav-drawer-scrim')) return;
    const s = el('div', 'nav-drawer-scrim'); s.id = 'nav-drawer-scrim';
    s.addEventListener('click', close);
    document.body.append(s);
    const menu = document.getElementById('nav-more-menu'); // however the menu is closed (its own handlers, a page that hides it), the scrim goes with it: it never stays over the page
    if (menu) { const watch = new MutationObserver(() => { if (menu.hidden || !s.isConnected) { watch.disconnect(); s.remove(); } }); watch.observe(menu, { attributes: true, attributeFilter: ['hidden'] }); }
}
export function hideScrim() { document.getElementById('nav-drawer-scrim')?.remove(); }
