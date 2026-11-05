/* The phone's ☰ drawer (#11472, Gmail's): a left drawer of OPTIONS in the current context, never the list of tabs (the bottom bar has those). The top of it is, from the Inbox or Chats, the Inbox's folders with their counts at the right
 * (Needs you, Tasks, Saved, Chats) and the teams; from every other screen Tasks and Chats (the bar has neither, #11535) and, from Agents, All agents and the teams; below a divider (nav_tabs.js adds them) are the less-used places: Docs, Computers, Settings, Themes, Check for updates (Automations and Analytics are bar tabs). It is the one
 * menu (#nav-more-menu) drawn as a panel: this file builds what is above the divider and the scrim behind it; css/mobile.css draws both. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { inboxCountsNow } from './inbox_tab.js';
import { identityKey, sessionServer, serverFetch } from './server_base.js';
import { teamLabel } from './server_status.js';
import { el } from './dom_el.js';


const heading = (cls, words) => { const h = el('div', cls, words); h.setAttribute('role', 'presentation'); return h; };
function countWords(label, count, { unread = false, noun: explicitNoun } = {}) {
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

function row(icon, label, count, run, current = false, countContext = {}) {
    const b = el('button', 'menu-item nav-more-item nav-drawer-folder'); b.type = 'button'; b.setAttribute('role', 'menuitem');
    if (current) { b.setAttribute('aria-current', 'true'); b.classList.add('is-current'); } // the open folder: marked by weight and a bar, and said in words
    const i = el('span', 'material-icons', icon); i.setAttribute('aria-hidden', 'true');
    b.append(i, el('span', 'nav-drawer-label', label));
    if (typeof count === 'string' && count) b.append(el('span', 'nav-drawer-count', count)); // Needs you says '0 of 3'
    else if (count > 0) b.append(el('span', 'nav-drawer-count', count > 99 ? '99+' : String(count)));
    if ((typeof count === 'string' && count) || count > 0 || (label === 'Needs you' && count === 0)) b.setAttribute('aria-label', `${label}, ${countWords(label, count, countContext)}`);
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
function drawTeams(host) {
    const keys = boards.keys.length ? boards.keys : liveTeamKeys();
    const n = k => (state.liveSessions || []).filter(s => s && s.board_project && identityKey(sessionServer(s), s.board_project) === k).length;
    host.replaceChildren(...(keys.length ? [heading('nav-drawer-group', 'Teams'), ...keys.map(k => row('group', teamLabel(k), n(k), () => window.openTeamPage?.(k), false, { noun: 'agent' }))] : []));
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
            const PLAIN = { 'saved-bookmark': 'star' };
            for (const sec of rows.sections) {
                if (sec.title && rows.sections.length > 1 && sec.items.length > 1) out.push(heading('nav-drawer-group', sec.title));
                for (const it of sec.items) out.push(row(PLAIN[it.icon] || (/^[a-z_]+$/.test(it.icon || '') ? it.icon : 'folder'), it.label, it.count, () => { window.switchNavTab?.('hub-inbox'); importOnce('./inbox_tab.js').then(() => rows.pick(it.key)); }, it.key === rows.current, { unread: it.unread }));
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
