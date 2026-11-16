import { loadStyles } from './lazy_styles.js';
loadStyles('board_quick_reply.css'); // a stylesheet, not an injected <style>: the Hub's CSP (style-src 'self') refuses an inline one (hub_board_link: style-src-elem)

function add(msg) {
    if (msg.querySelector('.mb-qr') || !msg.dataset.messageId) return;
    const who = msg.querySelector('.mb-row-who');
    if (!who) return;
    msg.style.position = 'relative';
    const name = who.getAttribute('title') || who.textContent;
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-small mb-qr', textContent: 'Reply' });
    b.setAttribute('data-on-click', 'mb-msg-reply');
    b.setAttribute('data-msg-id', msg.dataset.messageId);
    b.setAttribute('data-sender', name);
    b.setAttribute('aria-label', `Reply to ${name}`);
    msg.append(b);
}

export function mount(root) {
    const sel = root.classList?.contains('mb-table') ? '.mb-message' : '.mb-table .mb-message';
    for (const m of root.querySelectorAll(sel)) add(m);
}

new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList.contains('mb-message')) add(n);
        else if (n.querySelector) for (const msg of n.querySelectorAll('.mb-message')) add(msg);
    }
}).observe(document.body, { childList: true, subtree: true });
mount(document);
