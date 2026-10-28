/* A small menu on a message the person sent (#10159, Desktop tester #10082): Copy, Save for later, and Send to another agent. Sending to another agent never sends: it puts the text in that agent's message box (its saved
 * draft, then the box when that agent is open) and says so; the person reads it and presses Send. One menu element for the page, placed beside the button that opened it, role="menu" with role="menuitem" items
 * (menu_button.js does the keys: arrows, Home and End, Escape back to the button). The text is the bubble's own words, set with textContent; an agent's name is the row's own identity. */
import { state, sessionKey, saveSessionDraft } from './state.js';
import { importOnce } from './import_once.js';
import { showToast, copyText } from './utils.js';
import { resolveSessionIdentity } from './session_state.js';
import { sessionServer, keyLabel } from './server_base.js';


function item(menu, label, run, { disabled = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'menu-item'; b.setAttribute('role', 'menuitem'); b.textContent = label;
    if (disabled) b.disabled = true; else b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); run(); });
    menu.append(b);
    return b;
}

/** Another agent's box gets the text added to its draft (after what is already typed there, a blank line between; an unsent message is never replaced); that agent opens with it in the box. Nothing is sent. */
async function prefill(row, text) {
    const key = sessionKey(row);
    const typed = (key && state.sessionInputText[key]) || '';
    const draft = typed.trim() ? `${typed.replace(/\s+$/, '')}\n\n${text}` : text;
    if (key) saveSessionDraft(key, draft);
    await window.selectLiveSession?.(row.name, row.agent_type, row.session_id, sessionServer(row), { focusChat: true });
    const box = document.getElementById('command-input');
    if (box && box.value !== draft) { box.value = draft; box.dispatchEvent(new Event('input', { bubbles: true })); }
    showToast(`Added to ${resolveSessionIdentity(row)}'s message box. Not sent.`);
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
    let text = (bubble.querySelector('.message-text')?.innerText || '').trim();
    if (bubble.classList.contains('assistant')) { const src = (await importOnce('./chat_messages.js')).bubbleSource.get(bubble); if (src) text = src.trim(); } // a reply is copied and sent as the agent wrote it (its markdown), as its Copy button does (#10540)
    item(menu, 'Copy', async () => { if (!(await copyText(text))) showToast('Could not copy', true); });
    const save = bubble.querySelector('.chat-save-btn');
    if (save) item(menu, save.getAttribute('aria-pressed') === 'true' ? 'Remove from saved' : 'Save for later', () => save.click());
    const head = document.createElement('div'); head.className = 'chat-msg-menu-head'; head.setAttribute('role', 'presentation'); head.textContent = 'Send to another agent'; menu.append(head);
    const cur = state.currentSession || {};
    const others = (state.liveSessions || []).filter(s => s.session_id && (s.session_id !== cur.session_id || sessionServer(s) !== sessionServer(cur)) && !s.archived && s.agent_type !== 'terminal');
    if (!others.length) item(menu, 'No other agents', () => {}, { disabled: true });
    // grouped by team (#10676): this agent's own team first, the other teams by name, the agents with no team last under "No team"; each team a heading over its agents
    const teams = new Map();
    for (const s of others) { const k = s.board_project || ''; if (!teams.has(k)) teams.set(k, []); teams.get(k).push(s); }
    const ownKey = cur.board_project || '', labelOf = k => (k ? keyLabel(k) : 'No team');
    const order = [...teams.keys()].sort((a, b) => (a === ownKey ? -1 : b === ownKey ? 1 : a === '' ? 1 : b === '' ? -1 : labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' })));
    order.forEach((k, i) => {
        const hid = `chat-msg-menu-team-${i}`, g = document.createElement('div'), h = document.createElement('div');
        h.id = hid; h.className = 'chat-msg-menu-team'; h.textContent = labelOf(k); g.setAttribute('role', 'group'); g.setAttribute('aria-labelledby', hid);
        menu.append(h, g);
        for (const s of teams.get(k)) item(g, resolveSessionIdentity(s), () => prefill(s, text));
    });
    const r = btn.getBoundingClientRect();
    openMenu(btn);
    menu.style.position = 'fixed'; menu.style.zIndex = '3000';
    const h = menu.getBoundingClientRect().height, w = menu.getBoundingClientRect().width;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}
