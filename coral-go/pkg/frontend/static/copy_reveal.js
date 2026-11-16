import { loadStyles } from './lazy_styles.js';
loadStyles('copy_reveal.css');
export function reveal(target) {
    const bubble = target.closest && target.closest(".chat-bubble.assistant");
    for (const old of document.querySelectorAll(".chat-bubble.copy-revealed")) {
        if (old !== bubble) old.classList.remove("copy-revealed");
    }
    if (bubble && !bubble.classList.contains("copy-revealed")) bubble.classList.add("copy-revealed");
}
