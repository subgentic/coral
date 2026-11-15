document.head.append(Object.assign(document.createElement('style'), { textContent:
    '.mb-qr{position:absolute;right:.875rem;top:50%;transform:translateY(-50%);z-index:1;margin:0;transition:opacity .1s}' +
    '@media(hover:hover){.mb-qr{opacity:0;pointer-events:none}' +
    '.mb-message:not(.mb-open):hover>.mb-qr,.mb-message:not(.mb-open):focus-within>.mb-qr{opacity:1;pointer-events:auto}}' +
    '.mb-open>.mb-qr{display:none}'
}));

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
    for (const m of root.querySelectorAll('.mb-table .mb-message')) add(m);
}

new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList.contains('mb-message')) add(n);
        else if (n.querySelector) for (const msg of n.querySelectorAll('.mb-message')) add(msg);
    }
}).observe(document.body, { childList: true, subtree: true });
