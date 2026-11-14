import { markHidden } from './visible_marks.js';
import { makeBubble } from './chat_bubbles.js';
import { unwrapPastedContent } from './pasted_content.js';
import { renderMarkdown } from './utils.js';
import { CHAT_MARKDOWN } from './markdown.js';

export function render(el, msg) {
    const p = makeBubble("chat-system chat-launch-prompt",
        '<span class="material-icons" aria-hidden="true">play_arrow</span><span class="chat-system-label">Coral’s start instructions</span><span class="chat-system-text"></span>');
    const b = document.createElement("button"); b.type = "button"; b.className = "chat-system-toggle";
    b.innerHTML = '<span class="material-icons" aria-hidden="true">expand_more</span>';
    b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-label", "Show start instructions");
    b.addEventListener("click", () => {
        const o = p.classList.toggle("open"); b.setAttribute("aria-expanded", String(o)); b.setAttribute("aria-label", o ? "Hide start instructions" : "Show start instructions");
        if (o && !p.dataset.filled) { p.dataset.filled = "1"; p.querySelector(".chat-system-text").innerHTML = renderMarkdown(markHidden(unwrapPastedContent(msg.content)), CHAT_MARKDOWN, 'chat'); }
    });
    p.appendChild(b); el.replaceWith(p);
}
