/* Jump to (#10579, the Desktop keyboard pass): Cmd/Ctrl+K opens a box that opens any agent or chat by name, from the keyboard and from anywhere in the page. The agents are the live list's (filtered as it is typed);
 * the chats are the History list's search (a short read per pause in typing, only when there are words). Up and Down move through the matches (the one menu keyboard), Enter opens one, Escape closes the box and the
 * focus goes back where it was (the dialog's own focus handling). The box is a combobox over a listbox; a line says when nothing matches. Names are set as text. */
import { state } from './state.js';
import { ensureBuilt } from './lazy_dom.js';
import { attachDialogFocus } from './dialog_focus.js';
import { historyLabel } from './history_label.js';
import { menuMove } from './menu_keys.js';
import { sessionServer, serverFetch } from './server_base.js';

let matches = [], current = -1, timer = 0, seq = 0;
const $ = id => document.getElementById(id);
const label = s => s.display_name || s.name || 'Agent';

function draw(none) {
    $('jump-list').replaceChildren(...matches.map((m, i) => {
        const li = document.createElement('li');
        li.className = 'menu-item jump-option'; li.id = `jump-opt-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === current)); li.textContent = m.label;
        return li;
    }));
    $('jump-input').setAttribute('aria-activedescendant', `jump-opt-${current}`);
    $('jump-status').textContent = none && !matches.length ? 'No matches' : '';
    $('jump-list').children[current]?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
    $('jump-modal').style.display = 'none'; // display-ok: the same inline state the dialog was opened with
    matches[i]?.open();
}

async function search() {
    const text = $('jump-input').value.trim().toLowerCase(), mine = ++seq, words = text.split(/\s+/).filter(Boolean);
    matches = (state.liveSessions || []).filter(s => !s.archived && words.every(w => `${label(s)} ${s.name || ''} ${s.board_project || ''}`.toLowerCase().includes(w))).slice(0, 8)
        .map(s => ({ label: label(s), open: () => window.selectLiveSession(s.name, s.agent_type, s.session_id || '', sessionServer(s), { focusChat: true }) }));
    current = matches.length ? 0 : -1;
    draw(!words.length);
    if (!words.length) return;
    try { // chats: the History list's own search, by words in the title or summary
        const data = await (await serverFetch('', `/api/sessions/history?${new URLSearchParams({ q: text, page_size: '6' })}`)).json();
        if (mine !== seq) return;
        matches = [...matches, ...data.sessions.filter(c => c.session_id).map(c => ({ label: `${historyLabel(c)} (chat)`, open: () => window.selectHistorySession(c.session_id) }))];
        if (current < 0 && matches.length) current = 0;
    } catch { /* the agents stay */ }
    if (mine === seq) draw(true);
}

/** Open the box (Cmd/Ctrl+K): empty, with the agents of the list under it. */
export function openJumpTo() {
    const modal = ensureBuilt('jump-modal'), input = $('jump-input');
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
    input.value = '';
    modal.style.display = 'flex'; // display-ok: a dialog is shown as the flex container the .modal rule centres
    attachDialogFocus(modal);
    search();
    input.focus();
}
