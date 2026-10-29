/* Keyboard shortcuts (#10050, the Desktop tester: nothing said how to start a chat without the mouse): Alt+N starts a new agent, ? lists the shortcuts (also in the gear menu). Both are ignored while a person is typing in a field, a dialog is open or
 * a terminal has the focus, so they never take a key from the composer or the terminal (Option+N is the tilde dead key on a Mac). The list is the one place that names them. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { sessionTeamKey } from './server_base.js';

// The list is the one place that names the keys, in the person's own: a Mac shows Cmd and Option, any other computer Ctrl and Alt (#10579).
export const shortcutList = (mac = onMac()) => {
    const c = mac ? 'Cmd+' : 'Ctrl+', o = mac ? 'Option' : 'Alt';
    return [[mac ? 'Cmd+Option+N' : 'Alt+N', 'New agent'], [`${c}P or ${c}K`, 'Jump to an agent, chat, team or goal'], [`${c}Shift+P or F1`, 'The command list'], [`${c},`, 'Settings'], [`${c}B`, 'Show or hide the sidebar'],
        [`${c}Shift+F`, 'Search all chats'], ['/', 'Search agents'], [`${o}+Down or Up`, 'Next or previous agent'], [`${o}+Shift+Down or Up`, 'Next or previous team'], ['Ctrl+`', "The agent's terminal, and back to its chat"],
        ['?', 'Show these shortcuts'], ['Enter', 'Send a message'], ['Shift+Enter', 'A new line in a message'], ['Escape', 'Stop a reply (empty message box); close a dialog or menu'], [`${c}F`, 'Find in a chat']];
};

const typing = t => !!t && t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="dialog"], .modal');
// The chat's message box is the one field Alt+N works in (#10253: a person typing a message could not reach New agent from the keyboard) where Alt+N types nothing: not on a Mac, where Option+N is the tilde dead key
const onMac = () => /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
const inMessageBox = t => t instanceof Element && t.id === 'command-input';
const dialogOpen = () => [...document.querySelectorAll('.modal-overlay, [role="dialog"]')].some(d => d.getClientRects().length > 0 && getComputedStyle(d).display !== 'none');

export async function showShortcuts() {
    const { showAlertModal } = await importOnce('./prompt_modals.js');
    const m = document.getElementById('alert-modal-message');
    showAlertModal('Keyboard shortcuts', shortcutList().map(([k, what]) => `${k}   ${what}`).join('\n'), () => { if (m) m.style.whiteSpace = ''; });
    if (m) m.style.whiteSpace = 'pre-line';
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
    const term = document.getElementById('live-view-btn-terminal'), chat = document.getElementById('live-view-btn-chat');
    if (!term || !term.getClientRects().length) return;
    (term.classList.contains('active') ? chat : term).click();
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
        if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') return to(toggleTerminal);
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
