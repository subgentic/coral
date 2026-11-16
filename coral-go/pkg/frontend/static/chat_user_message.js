import { loadStyles } from './lazy_styles.js';
import { makeBubble } from './chat_bubbles.js';
import { thumbHtml, wireThumbs, sharedImageChips } from './chat_thumbs.js';
import { splitSharedImages } from './shared_images.js';
import { unwrapPastedContent } from './pasted_content.js';
import { visibleName } from './artifact_names.js';
import { markHidden } from './visible_marks.js';
import { escapeHtml, renderMarkdown } from './utils.js';
import { CHAT_MARKDOWN } from './markdown.js';
import { SAVE_BUTTON } from './saved_marks.js';
import { messageTimeHtml } from './message_time.js';
await loadStyles('chat_team_instructions.css');
function attachmentChips(attachments) {
    const chips = (Array.isArray(attachments) ? attachments : []).filter(a => a && a.name).map(a =>
        `<span class="chip chip-tag chat-attachment-chip">${escapeHtml(visibleName(a.name))}${a.file ? ` <span class="chat-attachment-file">${escapeHtml(a.file)}</span>` : ""}</span>${thumbHtml(a)}`);
    return chips.length ? `<div class="chat-attachments">${chips.join("")}</div>` : "";
}

function buildUser(msg, messageMenuButton) {
    if (msg.type === "user" && msg.coral_notice !== false &&
        /You were automatically joined to message board "[^"\n]+"/.test(String(msg.content || "")) &&
        String(msg.content).includes('Use the coral-board CLI to communicate with your teammates:') &&
        String(msg.content).includes('Do NOT run coral-board join')) {
        // Preserve the full generated launch source, including literal CLI placeholders.
        const bubble = makeBubble("chat-note", "");
        const details = document.createElement("details"); details.className = "chat-team-instructions";
        const summary = document.createElement("summary"); summary.textContent = "Team instructions";
        const source = document.createElement("pre"); source.textContent = unwrapPastedContent(msg.content);
        details.append(summary, source); bubble.append(details); return bubble;
    
    }
        // Images pasted in the dashboard lead the turn as "<path> coral://artifacts/<hex>" pairs (#5284): shown as artifact thumbnails, not as the text of a path and a link.
        const lead = splitSharedImages(unwrapPastedContent(msg.content));
        const bubble = makeBubble("chat-bubble human",
            `<div class="role-label">You</div><div class="message-text prose">${renderMarkdown(markHidden(lead.rest), CHAT_MARKDOWN, 'chat')}</div>${attachmentChips(msg.attachments)}${sharedImageChips(lead.images)}${messageMenuButton(lead.rest)}${msg.key ? SAVE_BUTTON : ""}${messageTimeHtml(msg.timestamp)}`);
        if (msg.key) { bubble.dataset.msgKey = msg.key; bubble.dataset.said = msg.timestamp || ""; } // Save for Later finds the message again by this (#4510)
        wireThumbs(bubble);
        return bubble;
}
export function fillUserMessage(slot, msg, messageMenuButton) {
    const bubble = buildUser(msg, messageMenuButton);
    slot.className = bubble.className; Object.assign(slot.dataset, bubble.dataset); slot.replaceChildren(...bubble.childNodes);
}
