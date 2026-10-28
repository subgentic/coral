/* A small menu on a message the person sent (#10159, Desktop tester #10082): Copy, Save for later, and Send to another agent. Sending to another agent never sends: it puts the text in that agent's message box (its saved
 * draft, then the box when that agent is open) and says so; the person reads it and presses Send. One menu element for the page, placed beside the button that opened it, role="menu" with role="menuitem" items
 * (menu_button.js does the keys: arrows, Home and End, Escape back to the button). The text is the bubble's own words, set with textContent; an agent's name is the row's own identity. */
import { state, sessionKey, saveSessionDraft } from './state.js';
import { importOnce } from './import_once.js';
import { showToast, copyText } from './utils.js';
import { resolveSessionIdentity } from './session_state.js';
import { sessionServer } from './server_base.js';

export const MESSAGE_MENU_BUTTON = '<button type="button" class="btn btn-quiet btn-icon btn-xs chat-msg-menu-btn" title="Message actions" aria-label="Message actions" aria-haspopup="menu" aria-expanded="false" aria-controls="chat-msg-menu"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg></button>';

function item(menu, label, run, { disabled = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'menu-item'; b.setAttribute('role', 'menuitem'); b.textContent = label;
    if (disabled) b.disabled = true; else b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); run(); });
    menu.append(b);
    return b;
}

/** Another agent's box gets the text as its draft; that agent opens with it in the box. Nothing is sent. */
async function prefill(row, text) {
    const key = sessionKey(row);
    if (key) saveSessionDraft(key, text);
    await window.selectLiveSession?.(row.name, row.agent_type, row.session_id, sessionServer(row), { focusChat: true });
    const box = document.getElementById('command-input');
    if (box && !box.value) { box.value = text; box.dispatchEvent(new Event('input', { bubbles: true })); }
    showToast(`The message is in ${resolveSessionIdentity(row)}'s box. Press Send to send it.`);
}

/** Open the menu for the message button `btn` (its bubble holds the text). */
export async function openMessageMenu(btn) {
    const bubble = btn.closest('.chat-bubble');
    if (!bubble) return;
    const { openMenu, closeMenus } = await importOnce('./menu_button.js');
    let menu = document.getElementById('chat-msg-menu');
    if (!menu) {
        menu = document.createElement('div'); menu.id = 'chat-msg-menu'; menu.className = 'menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Message actions'); menu.hidden = true;
        document.body.append(menu);
    }
    if (btn.getAttribute('aria-expanded') === 'true') { closeMenus({ restoreFocus: true }); return; }
    menu.replaceChildren();
    const text = (bubble.querySelector('.message-text')?.innerText || '').trim();
    item(menu, 'Copy', async () => { if (!(await copyText(text))) showToast('Could not copy', true); });
    const save = bubble.querySelector('.chat-save-btn');
    if (save) item(menu, save.getAttribute('aria-pressed') === 'true' ? 'Remove from saved' : 'Save for later', () => save.click());
    const head = document.createElement('div'); head.className = 'chat-msg-menu-head'; head.setAttribute('role', 'presentation'); head.textContent = 'Send to another agent'; menu.append(head);
    const cur = state.currentSession || {};
    const others = (state.liveSessions || []).filter(s => s.session_id && s.session_id !== cur.session_id && !(cur.name && s.name === cur.name && sessionServer(s) === sessionServer(cur)) && !s.archived && s.agent_type !== 'terminal');
    if (!others.length) item(menu, 'No other agents', () => {}, { disabled: true });
    for (const s of others) item(menu, resolveSessionIdentity(s), () => prefill(s, text));
    const r = btn.getBoundingClientRect();
    openMenu(btn);
    menu.style.position = 'fixed'; menu.style.zIndex = '3000';
    const h = menu.getBoundingClientRect().height, w = menu.getBoundingClientRect().width;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}
