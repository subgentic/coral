// A new question takes the keyboard on its first answer (#10410, Beta #10401: it went to the hidden terminal box and the answers were 53 Tab stops away), unless the person is in the middle of a message in the box or somewhere else that holds words.
// Returns true when the card is done with it (it took the keyboard, or the person is somewhere else), false while it still waits: the card is out of the page or has no answer yet (the chat draws its history again as it loads, lifting the card out and
// back, and the screen's answers can arrive a poll later), so the card asks again at its next draw (#18822).
export function takeKeyboard(card) {
    if (!card.isConnected) return false;
    const now = document.activeElement;
    const free = !now || now === document.body || (now.id === "command-input" && !now.value);
    if (!free) return true;
    const trust = card.querySelector('[data-label="Yes, I trust this folder"]');
    if (trust) card.tabIndex = -1;
    const to = trust ? card : card.querySelector(".cni-answer:not(:disabled)");
    if (!to) return false;
    to.focus({ preventScroll: true });
    return true;
}
