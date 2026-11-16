// A new question takes the keyboard on its first answer (#10410, Beta #10401: it went to the hidden terminal box and the answers were 53 Tab stops away), unless the person is in the middle of a message in the box or somewhere else that holds words.
export function takeKeyboard(card) {
    if (!card.isConnected) return;
    const now = document.activeElement;
    const free = !now || now === document.body || (now.id === "command-input" && !now.value);
    if (!free) return;
    const trust = card.querySelector('[data-label="Yes, I trust this folder"]');
    if (trust) card.tabIndex = -1;
    (trust ? card : card.querySelector(".cni-answer:not(:disabled)"))?.focus({ preventScroll: true });
}

