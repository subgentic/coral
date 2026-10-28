/* Keyboard shortcuts (#10050, the Desktop tester: nothing said how to start a chat without the mouse): Alt+N starts a new agent, ? lists the shortcuts (also in the gear menu). Both are ignored while a person is typing in a field, a dialog is open or
 * a terminal has the focus, so they never take a key from the composer or the terminal (Option+N is the tilde dead key on a Mac). The list is the one place that names them. */
import { importOnce } from './import_once.js';

export const SHORTCUTS = [
    ['Alt+N', 'New agent'],
    ['?', 'Show these shortcuts'],
    ['Enter', 'Send a message'],
    ['Shift+Enter', 'A new line in a message'],
    ['Ctrl+F or Cmd+F', 'Find in a chat'],
    ['Escape', 'Close a dialog, menu or panel'],
];

const typing = t => !!t && t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"], .xterm, [role="dialog"], .modal');
// The chat's message box is the one field Alt+N works in (#10253: a person typing a message could not reach New agent from the keyboard) where Alt+N types nothing: not on a Mac, where Option+N is the tilde dead key
const onMac = () => /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
const inMessageBox = t => t instanceof Element && t.id === 'command-input';
const dialogOpen = () => [...document.querySelectorAll('.modal-overlay, [role="dialog"]')].some(d => d.getClientRects().length > 0 && getComputedStyle(d).display !== 'none');

export async function showShortcuts() {
    const { showAlertModal } = await importOnce('./prompt_modals.js');
    const m = document.getElementById('alert-modal-message');
    showAlertModal('Keyboard shortcuts', SHORTCUTS.map(([k, what]) => `${k}   ${what}`).join('\n'), () => { if (m) m.style.whiteSpace = ''; });
    if (m) m.style.whiteSpace = 'pre-line';
}

export function newAgentShortcut() {
    window.showLaunchModal?.();
    window._selectLaunchType?.('agent');
}

export function wireShortcuts() {
    document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.isComposing) return;
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN') { // from the page, the sidebar and the chat's message box (not on a Mac): Option+N is the tilde dead key there, and a terminal has its own meta-n
            if (dialogOpen() || (typing(e.target) && !(inMessageBox(e.target) && !onMac()))) return;
            e.preventDefault(); newAgentShortcut(); return;
        }
        if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !dialogOpen()) { e.preventDefault(); showShortcuts(); }
    });
}
