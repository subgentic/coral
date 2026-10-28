/* The new-message pill and what a screen reader is told of arrivals (moved out of message_board.js, #8399; no behaviour change). */
import { bs } from './board_state.js';

// What arrives while the board is at the bottom is said once, politely, to a screen reader (the pill below does that for a board read higher up): who, and the start
// of what they wrote; several at once are a count and the latest. Nothing for the task queue's own lines, a system post, or what the Operator posted themselves.
let _announceFlip = false;

export function announceArrivals(fresh, atBottom) {
    if (!atBottom) return;
    const said = fresh.filter(m => m && !m.is_system && m.subscriber_id !== 'Operator' && String(m.content || '').trim());
    const region = document.getElementById('mb-announce');
    if (!said.length || !region) return;
    const last = said[said.length - 1];
    const who = last.job_title || last.subscriber_id || 'Unknown';
    const start = String(last.content).replace(/\s+/g, ' ').trim();
    const text = start.length > 140 ? start.slice(0, 140) + '…' : start;
    _announceFlip = !_announceFlip;
    region.textContent = (said.length === 1 ? `New message from ${who}: ${text}` : `${said.length} new messages. The latest is from ${who}: ${text}`) + (_announceFlip ? '' : ' ');
}

// Reading higher up: the posts a poll brings are not shown to you, so a small pill at the board's bottom edge counts them and jumps to the latest
// (#4502). A polite live region announces it; it goes when the board is at the bottom again, by the button or by scrolling.
export function noteUnseenMessages(n) {
    if (!n) return;
    bs._unseen += n;
    renderNewPill();
}

function renderNewPill() {
    const pill = document.getElementById('mb-new-pill');
    if (!pill) return;
    // The live region stays displayed and only its text changes (a region hidden and shown with its text can go unannounced).
    const btn = pill.querySelector('button');
    btn.textContent = bs._unseen > 0 ? `${bs._unseen} new message${bs._unseen === 1 ? '' : 's'}, jump to latest` : '';
    btn.hidden = bs._unseen <= 0;
}

export function clearNewPill() { bs._unseen = 0; renderNewPill(); }

export function jumpToLatest() {
    const container = document.getElementById('mb-messages');
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    clearNewPill();
    container.focus({ preventScroll: true });
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; }); // the focus can leave the composer, and a phone's page unfolds around it (#10088): once more, on the settled layout
}
