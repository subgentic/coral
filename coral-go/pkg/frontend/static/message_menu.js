/* A small menu on a message in the chat, the person's own or an agent's reply (#10159, #10540): Copy, and Save for later. One menu element for the page, placed beside the button that opened it, role="menu" with role="menuitem" items
 * (menu_button.js does the keys: arrows, Home and End, Escape back to the button). The text is the bubble's own words, set with textContent. */
import { importOnce } from './import_once.js';
import { showToast, copyText } from './utils.js';

function item(menu, label, run) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'menu-item'; b.setAttribute('role', 'menuitem'); b.textContent = label;
    b.addEventListener('click', async () => { (await importOnce('./menu_button.js')).closeMenus(); run(); });
    menu.append(b);
    return b;
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
    const r = btn.getBoundingClientRect();
    openMenu(btn);
    menu.style.bottom = ''; menu.style.translate = ''; // placed here (fixed, top and left): openMenu's "above its button" (bottom: calc(100% + 4px)) and nudge, left on it, stretched the box between top and bottom: 10 px, the items hanging out (#10780)
    menu.style.position = 'fixed'; menu.style.zIndex = '3000';
    const h = menu.getBoundingClientRect().height, w = menu.getBoundingClientRect().width;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}
