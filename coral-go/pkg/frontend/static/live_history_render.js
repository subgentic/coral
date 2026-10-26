/* Live history reply helpers: message indexes, page stitching, prompt state and post-render sync. Moved from live_chat.js (#8353). */

import { syncHooksComposer } from './hooks_review.js';
import { state } from './state.js';
import { escapeHtml } from './utils.js';
import { updateWorkGroupSummary } from './chat_content.js';
import { makeBubble } from './chat_bubbles.js';
import { loginBySession, pendingToolBySession, promptOptionsBySession, syncNeedsInputCard } from './needs_input_card.js';
import { syncPendingBubbles, syncWorkingIndicator } from './pending_messages.js';
import { keptPages } from './chat_kept_pages.js';
import { syncJumpToLatest } from './chat_jump_latest.js';
import { syncEmptyState } from './chat_prompt_empty.js';

// A trimmed message (#3723) keeps its absolute index, so its card can load it in full.
export function noteIndexes(messages, start) {
    messages.forEach((m, i) => { if (m && m.trimmed) m._index = start + i; });
}

// Join a prepended older page to the page after it: a run of tool calls split by the page
// boundary is one group again. A reply at the end of the older page stays a reply (#4105).
export function stitchPages(lastOlder) {
    let next = lastOlder && lastOlder.nextElementSibling;
    // The page after may open with a roll-up bar in front of its run: the group the tool run continues into is the bar's first member
    // (rollUpGroups then makes one bar of the run again).
    if (next && next.classList.contains("work-rollup")) next = next.nextElementSibling;
    if (!next || !next.classList.contains("work-group")) return;
    const nextBody = next.querySelector(":scope > .work-group-body");
    if (lastOlder && lastOlder.classList.contains("work-group")) {
        const olderBody = lastOlder.querySelector(":scope > .work-group-body");
        while (nextBody.firstChild) olderBody.appendChild(nextBody.firstChild);
        next.remove();
        updateWorkGroupSummary(lastOlder);
    } else {
        updateWorkGroupSummary(next);
    }
}


function syncUsageLimitNotice(container, notice) {
    const existing = container.querySelector('.chat-usage-limit-notice');
    if (!notice) {
        existing?.remove();
        return;
    }
    if (existing) {
        existing.querySelector('.message-text').textContent = notice;
        return;
    }
    const bubble = makeBubble('chat-note chat-usage-limit-notice', `<span class="material-icons" aria-hidden="true">warning</span><span class="message-text">${escapeHtml(notice)}</span>`);
    container.append(bubble);
}


/** What the reply carries beyond the messages: the pending tool call, the options of an open prompt, a sign-in the CLI waits on. */
export function _noteReplyState(session, data) {
    // What the server says about an open prompt rides on this reply (#3720): the pending tool call, and the options
    // of a prompt that may be open on the terminal.
    pendingToolBySession.set(session.session_id, data.pending || null);
    const po = data.prompt_options;
    if (po) promptOptionsBySession.set(session.session_id, { title: po.title || "", question: po.question || "", options: po.options || [], review: po.review || [], multi: !!po.multi, submit: po.submit || null });
    else promptOptionsBySession.delete(session.session_id);
    // A sign-in the CLI waits on (#3830): the reply is fresher than the session row.
    if (typeof data.needs_login === "boolean") loginBySession.set(session.session_id, data.needs_login ? { reason: String(data.login_reason || "") } : null);
    syncHooksComposer(session); // Codex's hooks question is in the box's words while it is open (#6409)
}

/** After a reply: the usage notice, the kept page's age, the pending bubbles, the working row, the empty state and the scroll. */
export function _syncAfterHistory(container, session, data) {
    syncUsageLimitNotice(container, data.limit_notice || '');
    // The agent is still on screen: its kept page is as fresh as this reply, so the time limit counts from when it left.
    const keptNow = keptPages.get(session.session_id);
    if (keptNow) keptNow.at = Date.now();

    // Pending first: it settles its place at the bottom, then the working row goes above it
    syncPendingBubbles(container, session.session_id);
    syncNeedsInputCard(container, session);
    syncWorkingIndicator(container, session);
    syncEmptyState(container);
    if (state.autoScroll) {
        container.scrollTop = container.scrollHeight;
    }
    syncJumpToLatest();
}
