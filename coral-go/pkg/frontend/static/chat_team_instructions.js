import { loadStyles } from './lazy_styles.js';
import { makeBubble } from './chat_bubbles.js';
import { appendContent } from './chat_content.js';
import { unwrapPastedContent } from './pasted_content.js';
await loadStyles('chat_team_instructions.css');
export function appendInstructions(msg, container) {
    const text = unwrapPastedContent(msg.content || '');
    if (msg.type !== 'user' || msg.coral_notice === false ||
        !/You were automatically joined to message board "[^"\n]+"/.test(text) ||
        !text.includes('Use the coral-board CLI to communicate with your teammates:') ||
        !text.includes('Do NOT run coral-board join')) return false;
    const bubble = makeBubble('chat-note', '');
    const details = document.createElement('details'); details.className = 'chat-team-instructions';
    const summary = document.createElement('summary'); summary.textContent = 'Team instructions';
    const source = document.createElement('pre'); source.textContent = text;
    details.append(summary, source); bubble.append(details); appendContent(container, bubble);
    return true;
}
