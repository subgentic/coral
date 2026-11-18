import { loadStyles } from './lazy_styles.js';
import { makeBubble } from './chat_bubbles.js';
import { appendContent } from './chat_content.js';
import { unwrapPastedContent } from './pasted_content.js';
import { appendCoralNotice, isCoralNudge } from './pending_messages.js';
import { renderMessage } from './chat_messages.js';
await loadStyles('chat_team_instructions.css');
// The board nudge and the person's lines after it are one user turn when the agent was busy (#19534; the same split as agent.SplitNudge): the notice, then their lines as their own turn.
export const NUDGE_THEN_TYPED = /^(You have (?:\d+ )?unread messages? on the message board\.(?: Run 'coral-board read' to see them\.)?)[ \t]*\r?\n+(\S[\s\S]*)$/;
export function appendInstructions(msg, container) {
    const text = unwrapPastedContent(msg.content || '');
    const mixed = msg.type === 'user' && msg.coral_notice !== false && NUDGE_THEN_TYPED.exec(text.trim());
    if (mixed && !isCoralNudge(mixed[2])) {
        appendCoralNotice(container, mixed[1], false);
        renderMessage({ ...msg, content: mixed[2].trim(), coral_notice: false }, container);
        return true;
    }
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
