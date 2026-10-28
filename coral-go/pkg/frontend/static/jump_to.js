/* Quick open and the command list (#10579, #10677; the keys VS Code and GoLand people know): Cmd/Ctrl+P or K opens Jump to, a box that opens any agent, chat, team or goal by name; Cmd/Ctrl+Shift+P (or F1) opens the
 * command list: Settings, the Inbox, a team's Goals, Tasks and Messages ... Up and Down move through the matches (the one menu keyboard), Enter opens one, Escape closes the box and the focus goes back where it was (the
 * dialog's own focus handling). The agents are the live list's; chats are the History list's search (a short read per pause in typing); goals are the open goals of every team, read once when the box opens. The box is a
 * combobox over a listbox; a line says when nothing matches. Names are set as text. */
import { state } from './state.js';
import { ensureBuilt } from './lazy_dom.js';
import { attachDialogFocus } from './dialog_focus.js';
import { historyLabel } from './history_label.js';
import { menuMove } from './menu_keys.js';
import { importOnce } from './import_once.js';
import { searchAllChats, showShortcuts } from './shortcuts.js';
import { sessionServer, serverFetch, sessionTeamKey, keyLabel } from './server_base.js';

let matches = [], current = -1, timer = 0, seq = 0, mode = 'jump', goals = [];
const $ = id => document.getElementById(id);
const label = s => s.display_name || s.name || 'Agent';
const here = () => state.selectedTeam || (state.currentSession && sessionTeamKey(state.currentSession)) || ''; // the team the person is in: its page, or its agent's
const go = tab => () => window.switchNavTab(tab);
const team = tab => () => window.openTeamPage(here(), { tab });
const COMMANDS = () => [
    ['Settings', () => window.showSettingsModal()], ['New agent', () => window.showLaunchModal() || window._selectLaunchType?.('agent')], ['New project', () => window.showLaunchModal() || window._selectLaunchType?.('team')],
    ['Go to Inbox', go('hub-inbox')], ['Go to Agents', go('agents')], ['Go to Automations', go('automations')], ['Go to Docs', go('docs')], ['Show or hide the sidebar', () => window.toggleSidebarRail()],
    ['Search all chats', searchAllChats], ['Keyboard shortcuts', showShortcuts],
    ...(here() ? [['Goals', 'goals'], ['Tasks', 'tasks'], ['Messages', 'messages'], ['Agents', 'agents'], ['Artifacts', 'artifacts']].map(([n, t]) => [`${keyLabel(here())}: ${n}`, team(t)]) : []),
].map(([text, open]) => ({ label: text, open }));

function draw(none) {
    $('jump-list').replaceChildren(...matches.map((m, i) => {
        const li = document.createElement('li');
        li.className = 'menu-item jump-option'; li.id = `jump-opt-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === current)); li.textContent = m.label;
        return li;
    }));
    if (current >= 0) $('jump-input').setAttribute('aria-activedescendant', `jump-opt-${current}`); else $('jump-input').removeAttribute('aria-activedescendant'); // nothing to point at when nothing matches
    $('jump-status').textContent = none && !matches.length ? 'No matches' : '';
    $('jump-list').children[current]?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
    if (!matches[i]) return; // Enter or a click with no match under it leaves the box open
    $('jump-modal').style.display = 'none'; // display-ok: the same inline state the dialog was opened with
    matches[i].open();
}

const has = (words, text) => words.every(w => text.toLowerCase().includes(w));

async function search() {
    const text = $('jump-input').value.trim().toLowerCase(), mine = ++seq, words = text.split(/\s+/).filter(Boolean);
    if (mode === 'commands') { matches = COMMANDS().filter(c => has(words, c.label)); current = matches.length ? 0 : -1; draw(true); return; }
    const agents = (state.liveSessions || []).filter(s => !s.archived && has(words, `${label(s)} ${s.name || ''} ${s.board_project || ''}`)).slice(0, 8)
        .map(s => ({ label: s.board_project ? `${label(s)} (${s.board_project})` : label(s), open: () => window.selectLiveSession(s.name, s.agent_type, s.session_id || '', sessionServer(s), { focusChat: true }) }));
    const teams = [...new Set((state.liveSessions || []).map(s => sessionTeamKey(s)).filter(Boolean))].filter(k => has(words, keyLabel(k))).slice(0, 5)
        .map(k => ({ label: `${keyLabel(k)} (team)`, open: () => window.openTeamPage(k, { tab: 'goals' }) }));
    const found = words.length ? goals.filter(g => has(words, g.title || '')).slice(0, 6).map(g => ({ label: `${g.title} (goal)`, open: () => window.openTeamPage(g.board_id, { tab: 'goals', item: g.id }) })) : [];
    matches = [...agents, ...teams, ...found];
    current = matches.length ? 0 : -1;
    draw(!words.length);
    if (!words.length) return;
    try { // chats: the History list's own search, by words in the title or summary
        const data = await (await serverFetch('', `/api/sessions/history?${new URLSearchParams({ q: text, page_size: '6' })}`)).json();
        if (mine !== seq) return;
        matches = [...matches, ...data.sessions.filter(c => c.session_id).map(c => ({ label: `${historyLabel(c)} (chat)`, open: () => window.selectHistorySession(c.session_id) }))];
        if (current < 0 && matches.length) current = 0;
    } catch { /* the rest stay */ }
    if (mine === seq) draw(true);
}

/** Open the box: Jump to ('jump', Cmd/Ctrl+P or K) or the command list ('commands', Cmd/Ctrl+Shift+P). */
export function openJumpTo(as = 'jump') {
    const modal = ensureBuilt('jump-modal'), input = $('jump-input');
    mode = as;
    if (!modal.dataset.wired) {
        modal.dataset.wired = '1';
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 150); });
        $('jump-list').addEventListener('mousedown', e => e.preventDefault()); // the box keeps the focus
        $('jump-list').addEventListener('click', e => choose([...$('jump-list').children].indexOf(e.target.closest('li'))));
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = menuMove(e.key, matches.length, current); if (to >= 0) { current = to; draw(); } } // Home and End stay the box's caret keys
            else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); choose(current); }
        });
    }
    const name = as === 'commands' ? 'Command' : 'Agent, chat, team or goal name';
    $('jump-title').textContent = as === 'commands' ? 'Commands' : 'Jump to';
    input.setAttribute('aria-label', name); input.placeholder = name;
    input.value = '';
    goals = [];
    if (as === 'jump') importOnce('./inbox_coral.js').then(m => m.listInboxGoals()).then(rows => { goals = rows || []; if (mode === 'jump' && $('jump-input').value.trim()) search(); }).catch(() => {}); // the open goals of every team, once
    modal.style.display = 'flex'; // display-ok: a dialog is shown as the flex container the .modal rule centres
    attachDialogFocus(modal);
    search();
    input.focus();
}
