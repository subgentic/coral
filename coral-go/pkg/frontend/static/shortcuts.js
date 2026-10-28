/* Keyboard shortcuts (#10050, the Desktop tester: nothing said how to start a chat without the mouse): Alt+N starts a new agent, ? lists the shortcuts (also in the gear menu). Both are ignored while a person is typing in a field, a dialog is open or
 * a terminal has the focus, so they never take a key from the composer or the terminal (Option+N is the tilde dead key on a Mac). The list is the one place that names them. */
import { importOnce } from './import_once.js';

// The list is the one place that names the keys, in the person's own: a Mac shows Cmd and Option, any other computer Ctrl and Alt (#10579).
const onMacNow = () => /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
export const shortcutList = (mac = onMacNow()) => [
    [mac ? 'Cmd+Option+N' : 'Alt+N', 'New agent'],
    [mac ? 'Cmd+K' : 'Ctrl+K', 'Jump to an agent or chat by name'],
    [mac ? 'Cmd+,' : 'Ctrl+,', 'Settings'],
    ['/', 'Search agents'],
    ['?', 'Show these shortcuts'],
    ['Enter', 'Send a message'],
    ['Shift+Enter', 'A new line in a message'],
    ['Escape', 'Stop a reply (in an empty message box); close a dialog, menu or panel'],
    [mac ? 'Cmd+F' : 'Ctrl+F', 'Find in a chat'],
];

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

export function wireShortcuts() {
    document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.isComposing) return;
        // Cmd/Ctrl+K jumps to an agent or chat by name and Cmd/Ctrl+, opens Settings (#10579): from the page and from the message box; not in a terminal (Ctrl+K is the shell's) or with a dialog open
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || e.key === ',') && !(e.ctrlKey && e.metaKey)) {
            if (dialogOpen() || (e.target instanceof Element && e.target.closest('.xterm'))) return;
            e.preventDefault();
            if (e.key === ',') window.showSettingsModal?.(); else importOnce('./jump_to.js').then(m => m.openJumpTo());
            return;
        }
        if (e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyN' && onMac()) { // Cmd+Option+N: the key a Mac's list shows; Ctrl+Option+N below still works
            if (dialogOpen() || (typing(e.target) && !inMessageBox(e.target))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !dialogOpen()) { // Search agents: the sidebar's box takes the key, as in most lists
            const box = document.getElementById('agent-search-input');
            if (box && box.getClientRects().length) { e.preventDefault(); box.focus(); }
            return;
        }
        if (e.altKey && e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN' && onMac()) { // Ctrl+Option+N: on a Mac the one way from the message box, since Option+N there is the tilde dead key (#10253); from a terminal or a dialog it does nothing, as Alt+N
            if (dialogOpen() || (typing(e.target) && !inMessageBox(e.target))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN') { // from the page, the sidebar and the chat's message box (not on a Mac): Option+N is the tilde dead key there, and a terminal has its own meta-n
            if (dialogOpen() || (typing(e.target) && !(inMessageBox(e.target) && !onMac()))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !dialogOpen()) { e.preventDefault(); showShortcuts(); }
    });
}
