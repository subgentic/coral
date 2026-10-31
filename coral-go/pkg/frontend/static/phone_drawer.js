/* The phone's ☰ drawer (#11472, Gmail's): a left drawer of OPTIONS in the current context, never the list of tabs (the bottom bar has those). The top of it is the Inbox's folders with their counts at the right
 * (Needs you, Tasks, Saved, Chats) and the teams; below a divider (nav_tabs.js adds them) are the less-used places: Automations, Analytics, Docs, Computers, Settings, Themes, Check for updates. It is the one
 * menu (#nav-more-menu) drawn as a panel: this file builds what is above the divider and the scrim behind it; css/mobile.css draws both. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { inboxCountsNow } from './inbox_tab.js';
import { identityKey, sessionServer } from './server_base.js';
import { teamLabel } from './server_status.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function row(icon, label, count, run) {
    const b = el('button', 'menu-item nav-more-item nav-drawer-folder'); b.type = 'button'; b.setAttribute('role', 'menuitem');
    const i = el('span', 'material-icons', icon); i.setAttribute('aria-hidden', 'true');
    b.append(i, el('span', 'nav-drawer-label', label));
    if (count > 0) b.append(el('span', 'nav-drawer-count', count > 99 ? '99+' : String(count)));
    b.addEventListener('click', run);
    return b;
}

const slot = name => () => document.querySelector(`.phone-nav-slot[data-phone-nav=${name}]`)?.click(); // the bar's own handler: the same page, the same lit tab

/** The nodes above the divider: the heading, the Inbox's folders and the teams. */
export function drawerTop() {
    const c = inboxCountsNow();
    const out = [el('div', 'nav-drawer-head', 'Coral')];
    out.push(row('email', 'Needs you', c.needs, slot('nav-inbox')), row('checklist', 'Tasks', c.tasks, slot('nav-tasks')),
        row('star', 'Saved', c.saved, () => { window.switchNavTab?.('hub-inbox'); importOnce('./inbox_tab.js').then(m => m.selectInboxTab('saved')); }), row('chat_bubble_outline', 'Chats', 0, slot('nav-chats')));
    const teams = new Map();
    for (const s of state.liveSessions || []) if (s && s.board_project) { const k = identityKey(sessionServer(s), s.board_project); teams.set(k, { name: s.board_project, n: (teams.get(k)?.n || 0) + 1 }); }
    if (teams.size) {
        out.push(el('div', 'nav-drawer-group', 'Teams'));
        for (const [k, t] of [...teams].sort((a, b) => a[1].name.localeCompare(b[1].name))) out.push(row('group', teamLabel(k) || t.name, t.n, () => window.openTeamPage?.(t.name)));
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
