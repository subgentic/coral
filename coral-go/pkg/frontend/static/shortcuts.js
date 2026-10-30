/* Keyboard shortcuts (#10050, the Desktop tester: nothing said how to start a chat without the mouse): Alt+N starts a new agent, ? lists the shortcuts (also in the gear menu). Both are ignored while a person is typing in a field, a dialog is open or
 * a terminal has the focus, so they never take a key from the composer or the terminal (Option+N is the tilde dead key on a Mac). The list is the one place that names them. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { sessionTeamKey } from './server_base.js';
import { isTerminalToggleKey } from './terminal_leave_key.js';

// The list is the one place that names the keys, in the person's own: a Mac shows Cmd and Option, any other computer Ctrl and Alt (#10579). Each row is [keys, what, group]; the group is the heading it sits under in the dialog (#11246).
export const SHORTCUT_GROUPS = ['Navigation', 'Chat', 'Search', 'Dialogs'];
export const shortcutList = (mac = onMac()) => {
    const c = mac ? 'Cmd+' : 'Ctrl+', o = mac ? 'Option' : 'Alt';
    return [[mac ? 'Cmd+Option+N' : 'Alt+N', 'New agent', 'Navigation'], [`${c}P or ${c}K`, 'Jump to an agent, chat, team or goal', 'Navigation'], [`${c}Shift+P or F1`, 'The command list', 'Navigation'], [`${c},`, 'Settings', 'Navigation'], [`${c}B`, 'Show or hide the sidebar', 'Navigation'],
        [`${c}Shift+F`, 'Search all chats', 'Search'], ['/', 'Search agents', 'Search'], [`${o}+Down or Up`, 'Next or previous agent', 'Navigation'], [`${o}+Shift+Down or Up`, 'Next or previous team', 'Navigation'], ['Ctrl+`', "The agent's terminal, and back to its chat (from the terminal too)", 'Navigation'],
        ['?', 'Show these shortcuts', 'Dialogs'], ['Enter', 'Send a message', 'Chat'], ['Shift+Enter', 'A new line in a message', 'Chat'], ['Escape', 'Stop a reply (empty message box); close a dialog or menu', 'Dialogs'], [`${c}F`, 'Find in a chat', 'Search']];
};

// A row's keys as chips: "Cmd+P or Cmd+K" is two alternatives of two keys each. A bare Up or Down after "Option+Down or" is the same modifiers with the other arrow. A Mac shows its glyphs; any other computer the words.
const GLYPH = { Cmd: '⌘', Option: '⌥', Shift: '⇧', Ctrl: '⌃', Down: '↓', Up: '↑', Escape: 'Esc' };
const GLYPH_NAME = { '⌘': 'Command', '⌥': 'Option', '⇧': 'Shift', '⌃': 'Control', '↓': 'Down arrow', '↑': 'Up arrow' }; // a glyph has no name a screen reader says right: the command sign is read as a place of interest
export const keyChips = (keys, mac = onMac()) => {
    const alts = [];
    for (const a of keys.split(' or ')) {
        const parts = a === '+' ? [a] : a.split(/\+(?=.)/);
        if (parts.length === 1 && /^(Up|Down)$/.test(parts[0]) && alts.length) parts.unshift(...alts[alts.length - 1].slice(0, -1));
        alts.push(parts);
    }
    return alts.map(parts => parts.map(k => (mac || /^(Down|Up|Escape)$/.test(k)) ? GLYPH[k] || k : k));
};

const typing = t => !!t && t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="dialog"], .modal');
// The chat's message box is the one field Alt+N works in (#10253: a person typing a message could not reach New agent from the keyboard) where Alt+N types nothing: not on a Mac, where Option+N is the tilde dead key
const onMac = () => /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
const inMessageBox = t => t instanceof Element && t.id === 'command-input';
const dialogOpen = () => [...document.querySelectorAll('.modal-overlay, [role="dialog"]')].some(d => d.getClientRects().length > 0 && getComputedStyle(d).display !== 'none');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** The dialog's body: a heading and a list for each group, a row being the keys (<dt>, one <kbd> chip a key) beside what they do (<dd>). */
export function buildShortcuts(mac = onMac()) {
    const frag = document.createDocumentFragment(), rows = shortcutList(mac);
    for (const group of SHORTCUT_GROUPS) {
        const sec = el('section', 'kbd-group'), h = el('h4', 'group-head', group), dl = el('dl', 'kbd-list');
        for (const [keys, what, g] of rows) {
            if (g !== group) continue;
            const row = el('div', 'kbd-row'), dt = el('dt', 'kbd-keys');
            keyChips(keys, mac).forEach((combo, i) => {
                if (i) dt.append(el('span', 'kbd-or', 'or'));
                const pair = el('span', 'kbd-combo'); // a key and its '+' stay on one line
                combo.forEach((k, n) => {
                    if (n && !mac) pair.append(el('span', 'kbd-plus', '+'));
                    const kbd = el('kbd', 'kbd-key', k);
                    if (GLYPH_NAME[k]) kbd.setAttribute('aria-label', GLYPH_NAME[k]);
                    pair.append(kbd);
                });
                dt.append(pair);
            });
            row.append(dt, el('dd', 'kbd-what', what)); dl.append(row);
        }
        sec.append(h, dl); frag.append(sec);
    }
    return frag;
}

export async function showShortcuts() {
    const m = document.getElementById('shortcuts-modal'), body = document.getElementById('shortcuts-body');
    if (!m || !body) return;
    body.replaceChildren(buildShortcuts());
    const close = document.getElementById('shortcuts-close');
    if (close && !close.dataset.wired) {
        close.dataset.wired = '1';
        close.addEventListener('click', () => { m.style.display = 'none'; }); // display-ok: a dialog is hidden by display none, as modal_chrome.js hides every unlisted one
    }
    m.style.display = 'flex'; // display-ok: a .modal shows as a flex overlay, as showAlertModal does
    body.scrollTop = 0;
    // The list is a Tab stop only while it scrolls: a keyboard user reaches the rows below the fold, and a list that fits (or an empty one) is no stop and no 16 px target (phone_layout)
    const sync = () => { body.tabIndex = body.scrollHeight > body.clientHeight + 1 ? 0 : -1; };
    sync();
    if (!body.dataset.syncWired) { body.dataset.syncWired = '1'; window.addEventListener('resize', sync); }
}

export function newAgentShortcut() {
    window.showLaunchModal?.();
    window._selectLaunchType?.('agent');
}

/** Open Inbox > All chats with its search box under the cursor (Cmd/Ctrl+Shift+F, and the command list's Search all chats). */
export function searchAllChats() {
    window.switchNavTab('hub-inbox');
    importOnce('./inbox_tab.js').then(m => m.selectInboxTab('chats')).then(() => {
        let tries = 0;
        const find = () => { const box = document.getElementById('gt-search'); if (box && box.getClientRects().length) box.focus(); else if (++tries < 20) setTimeout(find, 50); }; // sleep-ok: the folder draws over frames
        find();
    });
}

/** The agent's terminal view, and back to its chat (Ctrl+`). */
function toggleTerminal() {
    const term = document.getElementById('live-view-btn-terminal'), chat = document.getElementById('live-view-btn-chat'), one = document.getElementById('live-view-switch');
    if (one && one.getClientRects().length) { const back = !!term && term.classList.contains('active'); one.click(); if (back) document.getElementById('command-input')?.focus(); return; } // a phone's one switch (#11187)
    if (!term || !term.getClientRects().length) return;
    const back = term.classList.contains('active');
    (back ? chat : term).click();
    if (back) document.getElementById('command-input')?.focus(); // from the terminal the focus was in it: the chat's message box takes it, so the next key is typed there and not into a terminal that is no longer shown (#10749)
}

/** The next or previous agent of the list, as it is drawn (Alt/Option+Down and Up), and the next or previous team. */
function moveAgent(by) {
    const rows = [...document.querySelectorAll('.session-group-item[data-session-id]')].filter(r => r.getClientRects().length && r.dataset.name);
    const at = rows.findIndex(r => r.getAttribute('aria-current') === 'true'), to = rows[(at + by + rows.length) % rows.length] || null;
    if (to) window.selectLiveSession(to.dataset.name, to.dataset.agentType, to.dataset.sessionId, to.dataset.server || '', { pointer: false }); // the keyboard stays where it is: the next press moves on (a message box would keep the arrows)
}
function moveTeam(by) {
    const teams = [...new Set((state.liveSessions || []).map(s => sessionTeamKey(s)).filter(Boolean))];
    const at = teams.indexOf(state.selectedTeam || (state.currentSession && sessionTeamKey(state.currentSession)) || '');
    if (teams.length) window.openTeamPage(teams[(at + by + teams.length) % teams.length], { tab: state.lastTeamTab || 'goals' });
}

export function wireShortcuts() {
    document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.isComposing) return;
        // The keys people know from VS Code and GoLand (#10579, #10677), from the page and the message box, never in a terminal or with a dialog open: Cmd on a Mac, Ctrl elsewhere (a Mac's Ctrl+B, F, K, P are its text-cursor keys).
        // Browsers keep Ctrl+Tab, Cmd+T, W, N, L and 1-9, so the next agent and team are Alt/Option+Down and Up; Firefox keeps Ctrl+Shift+P (a private window) on Windows and Linux, so F1 opens the command list there too.
        const cmd = onMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey, k = e.key.toLowerCase(), live = () => !dialogOpen() && !e.target.closest?.('.xterm'); // looked up only once a shortcut matches: not on every key typed (perf_budgets: no page-wide lookup per keystroke)
        const to = f => { if (live()) { e.preventDefault(); f(); } }, open = as => to(() => importOnce('./jump_to.js').then(m => m.openJumpTo(as)));
        if (cmd && !e.altKey && !e.shiftKey && (k === 'k' || k === 'p')) return open('jump');
        if ((cmd && !e.altKey && e.shiftKey && k === 'p') || (e.key === 'F1' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)) return open('commands');
        if (cmd && !e.altKey && !e.shiftKey && k === ',') return to(() => window.showSettingsModal());
        if (cmd && !e.altKey && !e.shiftKey && k === 'b') return to(() => window.toggleSidebarRail());
        if (cmd && !e.altKey && e.shiftKey && k === 'f') return to(searchAllChats);
        if (isTerminalToggleKey(e)) { // the one page shortcut that also works from the terminal: it is the way back to the chat, and the terminal does not send it on (xterm_renderer.js)
            if (!dialogOpen()) { e.preventDefault(); toggleTerminal(); }
            return;
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing(e.target)) return to(() => (e.shiftKey ? moveTeam : moveAgent)(e.key === 'ArrowDown' ? 1 : -1));
        if (e.altKey && (e.ctrlKey !== e.metaKey) && !e.shiftKey && e.code === 'KeyN' && onMac()) { // Cmd+Option+N (the key a Mac's list shows) and Ctrl+Option+N // Ctrl+Option+N: on a Mac the one way from the message box, since Option+N there is the tilde dead key (#10253); from a terminal or a dialog it does nothing, as Alt+N
            if (dialogOpen() || (typing(e.target) && !inMessageBox(e.target))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN') { // from the page, the sidebar and the chat's message box (not on a Mac): Option+N is the tilde dead key there, and a terminal has its own meta-n
            if (dialogOpen() || (typing(e.target) && !(inMessageBox(e.target) && !onMac()))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if ((e.key === '?' || e.key === '/') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !dialogOpen()) { // ? lists the keys; / is Search agents: the sidebar's box takes the key, as in most lists
            const box = document.getElementById('agent-search-input');
            if (e.key === '?') { e.preventDefault(); showShortcuts(); } else if (box && box.getClientRects().length) { e.preventDefault(); box.focus(); }
        }
    });
}
