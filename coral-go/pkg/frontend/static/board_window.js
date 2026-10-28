/* The board's windowed message list: loading a page, loading the earlier ones, rendering, prepending, trimming and the header (moved out of message_board.js, #8399; no behaviour change). */
import { importOnce } from './import_once.js';
import { fetchMessages, PAGE_SIZE, mergeMessages } from './board_fetch.js';
import { isBusyStatus, busyRetryingText, machineOf, afterPause } from './overload.js';
import { isCloud, keyLabel } from './server_base.js';
import { nameSaveButton, aboutRow, BOARD_SAVE_BUTTON } from './saved_marks.js';
import { renderTaskQueueRun, groupTaskQueueRuns } from './board_system_lines.js';
import { authorLabel } from './board_author.js';
import { getAgentColor, isOperatorId, OPERATOR_ID, escapeAttr, boardMessageColorStyle, escapeHtml, externalMessageBadge, replyWithHtml, hubUserBadge, askBadge, renderBoardMessageBody } from './utils.js';
const { isSelectMode, isSelected } = await importOnce('./board_export.js'); // a part of the board page's group: loaded with it
import { rowParts, toggleRow, revealRow, sameDay, dayDividerHtml, refreshReplies } from './board_table.js';
import { messageTimeHtml } from './message_time.js';
import { messageAttachmentAttrs, messageAttachmentsHtml } from './board_attachments.js';
import { resolveBoardArtifacts } from './board_artifacts.js';
import { state } from './state.js';
import { scrollBehavior } from './motion.js';
import { highlightBoard } from './board_search.js';
import { emptyState } from './dom_write.js';
import { bs } from './board_state.js';
const { announceArrivals, clearNewPill, noteUnseenMessages } = await importOnce('./board_new_pill.js'); // a part of the board page's group: loaded with it

export async function loadBoardMessages(project) {
    const msgsEl = document.getElementById('mb-messages');
    const empty = document.getElementById('mb-messages-empty');
    if (empty) empty.style.display = 'none';
    // Show loading indicator below any existing messages
    let loadingEl = msgsEl?.querySelector('.loading-indicator');
    if (!loadingEl && msgsEl) {
        loadingEl = document.createElement('div');
        loadingEl.className = 'loading-indicator';
        loadingEl.setAttribute('role', 'listitem');
        loadingEl.textContent = 'Loading messages';
        msgsEl.appendChild(loadingEl);
    }
    bs._loadedProject = null;
    try {
        const result = await fetchMessages(project, PAGE_SIZE);
        if (bs.currentProject !== project) return;
        bs._loadedProject = project;
        bs._totalMessages = bs._countedTotal = result.total;
        bs._staleRows = false;
        bs._allMessages = result.messages;
        bs._loadedOffset = result.beforeCount;
        renderMessages(bs._allMessages);
    } catch (e) {
        // Refused as busy (#3430): say it is retrying, and load again once the pause is over
        // instead of at the next 10 s poll (which only fetches new messages after a first load).
        if (e && e.resp && isBusyStatus(e.resp.status) && bs.currentProject === project) {
            if (loadingEl) {
                loadingEl.classList.add('mb-busy');
                loadingEl.setAttribute('role', 'status');
                loadingEl.textContent = busyRetryingText(e.resp, { hub: isCloud() });
            }
            let machine = '';
            try { machine = machineOf(new URL(e.resp.url).pathname); } catch { /* same server */ }
            clearTimeout(_boardBusyRetry);
            _boardBusyRetry = afterPause(() => {
                _boardBusyRetry = null;
                if (bs.currentProject === project && bs._loadedProject !== project) loadBoardMessages(project);
            }, machine);
            return;
        }
        console.error('Failed to load board messages:', e);
    }
}

let _boardBusyRetry = null;

let _earlierInFlight = false;

export async function loadEarlierMessages() {
    const project = bs.currentProject;
    if (!project || bs._loadedProject !== project || bs._loadedOffset <= 0 || !bs._allMessages.length || _earlierInFlight) return;
    _earlierInFlight = true;
    setEarlierLoading(true);
    const firstId = bs._allMessages[0].id;
    let result;
    try {
        result = await fetchMessages(project, PAGE_SIZE, { before_id: firstId });
    } catch (e) {
        console.error('Failed to load earlier messages:', e);
        return;
    } finally {
        _earlierInFlight = false; // before the render: a search jump that still misses its message loads the next page from it
        setEarlierLoading(false); // the line goes with the load, success or not
    }
    // A trim or a reload while it was out moved the oldest message loaded: this page would leave a gap.
    if (bs.currentProject !== project || !bs._allMessages.length || bs._allMessages[0].id !== firstId) return;
    const had = bs._allMessages.length;
    bs._allMessages = mergeMessages(result.messages, bs._allMessages);
    bs._loadedOffset = result.beforeCount;
    renderMessages(bs._allMessages, { keepAnchor: true, prepended: bs._allMessages.length - had });
    const added = bs._allMessages.length - had;
    sayEarlier(added > 0 ? `${added} earlier message${added === 1 ? '' : 's'} loaded${bs._loadedOffset <= 0 ? '. This is the start of the board' : ''}.` : '');
}

// The board keeps about this many messages in the DOM while you read at the bottom (#4492): a poll appends what is new, and once
// a page more than this has built up the oldest go (they count as not loaded, so scrolling up or "Load earlier" brings them back).
// Nothing is dropped while you read higher up, select messages or wait for a search jump.
const BOARD_KEEP = 300;

export const ROW = ':scope > .mb-message, :scope > .mb-queue-run';

export function isAtBottom(container) {
    return (container.scrollHeight - container.scrollTop - container.clientHeight) < 50;
}

// Scrolling near the top loads the page before the oldest message shown, as "Load earlier" does. Not the scroll that moving
// keyboard focus onto "Load earlier" makes (the browser scrolls it into view): that is the reader reaching the button, who
// then presses it or not (Frontend's finding on #4492).
/** Earlier messages with nothing to scroll: a box the loaded messages do not fill (short messages, a tall window) never gets a scroll event, so the page before loads without one. */
function fillTop() {
    const c = document.getElementById('mb-messages');
    if (c && c.clientHeight > 0 && bs._loadedOffset > 0 && !_earlierInFlight && c.scrollHeight <= c.clientHeight + 80) loadEarlierMessages();
}

function wireBoardScroll(container) {
    if (container._mbScrollWired) return;
    container._mbScrollWired = true;
    let focusScrollUntil = 0;
    container.addEventListener('focusin', (e) => {
        if (e.target.closest?.('.mb-load-earlier')) focusScrollUntil = performance.now() + 300;
    });
    // The newest message stays in view when the box changes height (the keyboard comes up or goes, the composer grows): a box that was at the end is at the end again (#10088); one scrolled up stays where it was.
    let pinned = isAtBottom(container);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (pinned && container.clientHeight > 0) container.scrollTop = container.scrollHeight; }).observe(container);
    container.addEventListener('scroll', () => {
        pinned = isAtBottom(container);
        if (performance.now() < focusScrollUntil && document.activeElement?.closest?.('.mb-load-earlier')) return;
        if (container.scrollTop < 80 && bs._loadedOffset > 0) loadEarlierMessages();
        if (bs._unseen && isAtBottom(container)) clearNewPill();
    }, { passive: true });
}

function boardHeaderHtml() {
    // No button and no count (#7762): scrolling near the top loads the page before the oldest message shown. One quiet line above the rows, once the board's first message is the one on screen ("Loading earlier messages\u2026" floats over the box while a page is out: setEarlierLoading).
    if (bs._loadedOffset <= 0 && bs._allMessages.length) return '<div class="mb-earlier-line" role="listitem">Start of the board</div>';
    return '';
}

// Names each row's Save and Delete by its message, so a list of them reads as different buttons. The text is the message's own (untrusted), so it goes in as an attribute value, never as markup.
function nameBoardButtons(root) {
    const rows = root.matches && root.matches('.mb-message') ? [root] : [...(root.querySelectorAll ? root.querySelectorAll('.mb-message') : [])];
    for (const row of rows) {
        const save = row.querySelector('.mb-save-btn');
        if (save) nameSaveButton(save);
        const about = aboutRow(save);
        row.querySelector('.mb-delete-msg-btn')?.setAttribute('aria-label', `Delete the message from ${about}`);
    }
}

// One row: a message, or a collapsed run of task-queue lines. prev is the item before it (grouping by sender).
function renderBoardItem(item, prev) {
    if (item.kind === 'queue') return renderTaskQueueRun(item, formatTime);
    const m = item.m;
    const color = getAgentColor(m.job_title || 'Unknown');
    const agent = m.job_title || 'Unknown';
    const prevMsg = prev && prev.kind === 'msg' ? prev.m : null;
    const prevAgent = prevMsg ? (prevMsg.job_title || 'Unknown') : null;
    const sameAsPrev = agent === prevAgent;
    const spacing = sameAsPrev ? 'mb-message-grouped' : 'mb-message-first';
    const isLeader = /orchestrator/i.test(agent) || isOperatorId(m.subscriber_id);
    const alignClass = isLeader ? ' board-msg-left' : ' board-msg-right';
    const selectedClass = isSelectMode() && isSelected(m.id) ? ' mb-message-selected' : '';
    const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const moreLabel = `Actions for the message from ${agent}, ${formatTime(m.created_at)}${snippet ? `: ${snippet}` : ''}`; // each one names its own message (three at one minute are three names)
    const deleteLabel = `Delete the message from ${agent}, ${formatTime(m.created_at)}`; // names the message: the × alone is read as "times"
    const parent = m.reply_to ? bs._allMessages[indexOfId(bs._allMessages, m.reply_to)] : null;
    const parts = rowParts(m, { agent, timeHtml: messageTimeHtml(m.created_at), moreLabel, replyName: m.reply_to ? (parent ? (parent.job_title || 'Unknown') : 'an earlier message') : '', self: OPERATOR_ID.toLowerCase() }); // the table's head, actions and flags (board_table.js)
    const checkbox = isSelectMode() ? `<input type="checkbox" class="check mb-select-checkbox" data-msg-id="${Number(m.id)}" ${isSelected(m.id) ? 'checked' : ''} data-on-click="mb-msg-select">` : '';
    return `
        <div class="mb-message ${spacing}${alignClass}${selectedClass}${parts.classes}"${parts.attrs} role="listitem" data-message-id="${escapeAttr(String(m.id))}"${m.reply_to ? ` data-reply-to="${Number(m.reply_to)}"` : ''}${messageAttachmentAttrs(m)} style="${boardMessageColorStyle(color)}">
            ${parts.toggle}
            <div class="mb-message-header">
                ${checkbox}
                <span class="mb-agent-name">${m.icon ? escapeHtml(m.icon) + ' ' : ''}${escapeHtml(authorLabel(m, agent))}</span>
                ${externalMessageBadge(m)}${hubUserBadge(m)}${askBadge(m)}
                ${messageTimeHtml(m.created_at)}
                ${BOARD_SAVE_BUTTON(bs.currentProject || '', keyLabel(bs.currentProject || ''), String(m.created_at || ''), String(m.job_title || m.subscriber_id || ''))}
                <button class="btn btn-quiet btn-icon btn-xs mb-delete-msg-btn" data-on-click="mb-msg-delete" data-msg-id="${Number(m.id)}" title="Delete message" aria-label="${escapeAttr(deleteLabel)}">&times;</button>
                <button type="button" class="mb-msg-more" data-on-click="mb-msg-more" aria-haspopup="dialog" title="Message actions" aria-label="${escapeAttr(moreLabel)}">&hellip;</button>
            </div>
            ${parts.tagsOpen}
            <div class="mb-message-body" id="mbd-${Number(m.id)}">${renderBoardMessageBody(m)}</div>
            ${messageAttachmentsHtml(m)}
            ${replyWithHtml(m)}
            ${parts.actions}
        </div>`;
}

/** On a phone a message's actions are behind one "..." (#7183): a sheet with Save for later (or Remove from saved) and, set apart below it, Delete. The buttons are the message's own (hidden on a phone): the sheet presses them. */
export function openMessageActions(opener) {
    const row = opener.closest('.mb-message'); if (!row) return;
    const messageId = row.dataset.messageId;
    const save = row.querySelector('.mb-save-btn'), del = row.querySelector('.mb-delete-msg-btn');
    const dlg = document.createElement('dialog'); dlg.className = 'mb-actions-sheet'; dlg.setAttribute('aria-labelledby', 'mb-actions-title');
    const title = document.createElement('h3'); title.id = 'mb-actions-title'; title.textContent = (opener.getAttribute('aria-label') || 'Message actions').replace(/^Actions for the m/, 'M').replace(/: .*$/, ''); // the snippet starts at ": "; the time's own colon (2:57 PM) is kept (it was cut to "Message from Operator, 2", #10730)
    dlg.append(title);
    const item = (cls, text, target) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.addEventListener('click', () => { dlg.close(); target.click(); }); return b; };
    if (save) dlg.append(item('btn mb-actions-item', save.getAttribute('aria-pressed') === 'true' ? 'Remove from saved' : 'Save for later', save));
    const select = opener.closest('.mb-table') && !isSelectMode() ? document.getElementById('mb-select-btn') : null; // the table's More holds Select too
    if (select) dlg.append(item('btn mb-actions-item', 'Select messages', select));
    if (del) { const apart = document.createElement('div'); apart.className = 'mb-actions-apart'; apart.append(item('btn mb-actions-item mb-actions-danger', 'Delete message', del)); dlg.append(apart); }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'btn mb-actions-item'; close.textContent = 'Close'; close.addEventListener('click', () => dlg.close());
    dlg.append(close); document.body.append(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); const back = opener.isConnected ? opener : document.querySelector(`.mb-message[data-message-id="${CSS.escape(String(messageId))}"] .mb-row-more, .mb-message[data-message-id="${CSS.escape(String(messageId))}"] .mb-msg-more`); if (back) back.focus(); }); // the list may have been drawn again (a save marks the row): the same message's button gets the focus
    dlg.showModal();
    dlg.querySelector('.mb-actions-item')?.focus();
}

// Where messages[i] is in the list, searching from the end (new rows are at the end).
function indexOfId(messages, id) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].id === id) return i;
    return -1;
}

// A row's first message id: a message row's own, a task-queue run's first line.
function rowFirstId(row) {
    return Number(row.classList.contains('mb-queue-run') ? row.dataset.queueRun : row.dataset.messageId);
}

// "Load earlier" (and a search jump's older pages) draws only the rows the page adds, in one batch above the rows shown (#4638): every older page used to
// draw the whole board again, which cost more with each page (a board of 700 took over a second in UX's run). The rows shown stay as they are, with the focus
// and what the reader opened; the first of them follows the new rows' last for grouping. Returns false (and the caller draws it all) when the rows shown are not
// the loaded messages after the page, in select mode, or when a task-queue run could join across the page's edge.
function prependEarlier(container, count) {
    const first = container.querySelector(ROW);
    if (!first || isSelectMode() || first.classList.contains('mb-queue-run') || container.querySelector(':scope > .empty-state, :scope > .loading-indicator')) return false;
    if (!bs._allMessages[count] || bs._allMessages[count].id !== rowFirstId(first)) return false;
    const items = groupTaskQueueRuns(bs._allMessages.slice(0, count + 1), true); // with the first message shown, to see what it would join
    const tail = items[items.length - 1];
    if (tail.kind !== 'msg' || tail.m.id !== bs._allMessages[count].id) return false;
    const fresh = items.slice(0, -1);
    const tmp = document.createElement('template');
    tmp.innerHTML = fresh.map((item, i) => renderBoardItem(item, i > 0 ? fresh[i - 1] : null)).join('');
    const added = [...tmp.content.children];
    const prev = fresh[fresh.length - 1];
    const grouped = !!prev && prev.kind === 'msg' && (prev.m.job_title || 'Unknown') === (tail.m.job_title || 'Unknown');
    first.className = first.className.replace(/mb-message-(first|grouped)/, grouped ? 'mb-message-grouped' : 'mb-message-first'); // in place: the same class order as a whole render
    const lead = first.previousElementSibling && first.previousElementSibling.classList.contains('mb-day') ? first.previousElementSibling : first; // the day line above the first row stays above the new rows
    lead.before(tmp.content);
    for (const el of added) { nameBoardButtons(el); resolveBoardArtifacts(el, state.currentBoardServer); }
    updateBoardHeader(container);
    return true; // (renderMessages draws the day dividers after it)
}

// The jump's landing: the message in the middle of the board with the focus on it (Save for Later's jump and the search's, #4510, #4771); the one before it loses its mark.
/** instant: the jump came after pages were loaded above it (the rows moved under it, a smooth scroll would be cut short by the page's own scroll adjustments, and a row near the top loads one more page): it lands at once. */
function revealMessage(target, instant = false) {
    for (const old of document.querySelectorAll('#mb-messages .chat-search-target')) if (old !== target) old.classList.remove('chat-search-target');
    const run = target.closest('details');
    if (run) run.open = true; // a task-queue line inside a collapsed row
    if (target.classList.contains('mb-message')) toggleRow(target, true); // a jump (a search hit, a saved message, a link) lands on the whole message
    target.classList.add('chat-search-target');
    if (target.classList.contains('mb-message') && target.parentElement && target.parentElement.classList.contains('mb-table')) revealRow(target, instant ? 'auto' : scrollBehavior());
    else target.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : scrollBehavior() });
    target.setAttribute('tabindex', '-1'); // the focus goes to the message
    target.focus({ preventScroll: true });
}

/** Go to a message of the board, loading the older pages until it is there (the board's own jump; the search's matches use it). */
export function focusMessageById(id) {
    const container = document.getElementById('mb-messages');
    const target = container && container.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`);
    if (target) { revealMessage(target); highlightBoard(container); return; }
    bs.pendingMessageId = String(id);
    loadEarlierMessages();
}

/** "First": every older page is loaded, and the board is at its first message. */
export async function jumpToFirst() {
    const container = document.getElementById('mb-messages');
    if (!container) return;
    for (let guard = 0; bs._loadedOffset > 0 && guard < 400; guard++) {
        const before = bs._loadedOffset;
        await loadEarlierMessages();
        if (bs._loadedOffset >= before) break;
    }
    container.scrollTop = 0;
    const first = container.querySelector(ROW);
    if (first) { first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true }); }
}

/** The day dividers: one above the first row of each day, kept in step with the rows after every draw, append, prepend and trim (a divider is no row: nothing else counts it). */
function syncDays(container) {
    const at = new Map(bs._allMessages.map(m => [String(m.id), m.created_at]));
    const rows = [...container.querySelectorAll(ROW)];
    let prev = null;
    for (const row of rows) {
        const when = at.get(String(rowFirstId(row)));
        const key = when ? new Date(when).toDateString() : null;
        const lead = row.previousElementSibling && row.previousElementSibling.classList.contains('mb-day') ? row.previousElementSibling : null;
        const wants = !!key && (prev === null || !sameDay(prev, when));
        if (wants && !(lead && lead.dataset.day === key)) {
            lead?.remove();
            row.insertAdjacentHTML('beforebegin', dayDividerHtml(when));
        } else if (!wants && lead) lead.remove();
        if (key) prev = when;
    }
    for (const d of container.querySelectorAll(':scope > .mb-day')) if (!d.nextElementSibling || !d.nextElementSibling.matches('.mb-message, .mb-queue-run')) d.remove();
}

export function renderMessages(messages, { keepAnchor = false, prepended = 0 } = {}) {
    const container = document.getElementById('mb-messages');
    wireBoardScroll(container);
    if (!messages.length) {
        emptyState(container, 'No messages on the board yet');
        container.firstElementChild.setAttribute('role', 'listitem'); // the messages box is a list: its one notice is an item
        return;
    }
    // Save scroll position before replacing content
    const prevScrollTop = container.scrollTop;
    const prevScrollHeight = container.scrollHeight;
    const wasAtBottom = isAtBottom(container);
    // "Load earlier" pressed from the keyboard is drawn again with the list: focus goes to the new one (UX on #4492).
    const earlierFocused = !!document.activeElement?.closest?.('#mb-messages > .mb-load-earlier');

    // Runs of task-queue lines are one collapsed row (#3343), except in select mode.
    if (!(prepended > 0 && prependEarlier(container, prepended))) {
        const items = groupTaskQueueRuns(messages, !isSelectMode());
        container.innerHTML = boardHeaderHtml() + items.map((item, i) => renderBoardItem(item, i > 0 ? items[i - 1] : null)).join('');
        nameBoardButtons(container);
        resolveBoardArtifacts(container, state.currentBoardServer);
    }
    syncDays(container);
    refreshReplies(container);
    if (earlierFocused) {
        // The button again, or with every message loaded the count line, so focus doesn't drop to the page.
        const next = container.querySelector(':scope > .mb-load-earlier button');
        if (next) next.focus({ preventScroll: true });
        else {
            const count = container.querySelector(':scope > .mb-message-count');
            if (count) { count.tabIndex = -1; count.focus({ preventScroll: true }); }
            else { container.tabIndex = -1; container.focus({ preventScroll: true }); } // every message is loaded and the count line is gone (#5991)
        }
    }
    if (bs.pendingMessageId) {
        const target = container.querySelector(`[data-message-id="${CSS.escape(bs.pendingMessageId)}"]`);
        if (target) {
            revealMessage(target, true);
            bs.pendingMessageId = null;
            highlightBoard(container);
            return; // the jump decides the scroll position
        } else if (bs._loadedOffset > 0) {
            // Search hits may be older than the initial latest page. Keep
            // loading real pages until the stable message id is present.
            loadEarlierMessages();
        }
    }
    highlightBoard(container);
    if (keepAnchor) {
        // Older messages went in above: what you were reading stays where it was.
        container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
    } else if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
    } else {
        container.scrollTop = prevScrollTop;
    }
    fillTop();
}

// A poll's new messages (already merged into _allMessages) go in after the rows shown (#4492): message rows already shown are
// left as they are, and only a task-queue run at the end is drawn again, since the new lines can extend it. Falls back to a whole
// render when the rows shown don't match the loaded messages.
export function appendNewMessages(count) {
    const container = document.getElementById('mb-messages');
    announceArrivals(bs._allMessages.slice(-count), isAtBottom(container)); // (a board read higher up is told by the pill below instead)
    const rows = container.querySelectorAll(ROW);
    const last = rows[rows.length - 1];
    const lastIdx = last ? indexOfId(bs._allMessages, rowFirstId(last)) : -1;
    if (!last || lastIdx < 0 || lastIdx >= bs._allMessages.length - count || container.querySelector(':scope > .empty-state, :scope > .loading-indicator')) {
        renderMessages(bs._allMessages);
        return;
    }
    const wasAtBottom = isAtBottom(container);
    const collapse = !isSelectMode();
    let start, prev, replace = null;
    if (last.classList.contains('mb-queue-run') && collapse) {
        start = lastIdx; // the run is drawn again with the new lines it gains
        replace = last;
        const before = rows.length > 1 ? rows[rows.length - 2] : null;
        prev = before && before.classList.contains('mb-message') ? { kind: 'msg', m: bs._allMessages[indexOfId(bs._allMessages, rowFirstId(before))] } : null;
        if (prev && !prev.m) prev = null;
    } else {
        start = lastIdx + 1; // a message row: kept, and the new rows group with it
        prev = { kind: 'msg', m: bs._allMessages[lastIdx] };
    }
    const items = groupTaskQueueRuns(bs._allMessages.slice(start), collapse);
    const tmp = document.createElement('template');
    tmp.innerHTML = items.map((item, i) => renderBoardItem(item, i > 0 ? items[i - 1] : prev)).join('');
    const added = [...tmp.content.children];
    if (replace) replace.replaceWith(tmp.content); else container.appendChild(tmp.content);
    for (const el of added) { nameBoardButtons(el); resolveBoardArtifacts(el, state.currentBoardServer); }
    if (wasAtBottom) trimBoardWindow(container);
    syncDays(container);
    refreshReplies(container);
    updateBoardHeader(container);
    highlightBoard(container);
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
    else noteUnseenMessages(count);
}

// Drops the oldest loaded messages beyond BOARD_KEEP, and their rows, once a page more has built up (see BOARD_KEEP).
function trimBoardWindow(container) {
    if (isSelectMode() || bs.pendingMessageId || bs._allMessages.length <= BOARD_KEEP + PAGE_SIZE) return;
    const drop = bs._allMessages.length - BOARD_KEEP;
    const firstKept = bs._allMessages[drop].id;
    // The message a search or Save for Later jump just landed on is kept: the jump's smooth scroll may not have left the bottom yet when a poll comes.
    const target = container.querySelector(':scope .chat-search-target');
    if (target && Number(target.dataset.messageId) < firstKept) return;
    bs._allMessages = bs._allMessages.slice(drop);
    bs._loadedOffset += drop;
    for (const row of container.querySelectorAll(ROW)) {
        if (row.classList.contains('mb-queue-run')) {
            const lines = [...row.querySelectorAll('.mb-queue-line')].map(l => Number(l.dataset.messageId));
            if (lines[lines.length - 1] < firstKept) { row.remove(); continue; }
            if (lines[0] < firstKept) { // a run across the cut: drawn again from its first kept line
                const run = groupTaskQueueRuns(bs._allMessages.slice(0, lines.filter(id => id >= firstKept).length), true)[0];
                const tmp = document.createElement('template');
                tmp.innerHTML = renderBoardItem(run, null);
                row.replaceWith(tmp.content);
            }
            break;
        }
        if (rowFirstId(row) < firstKept) { row.remove(); continue; }
        // The first message shown starts its group: there is no row above it now.
        row.classList.replace('mb-message-grouped', 'mb-message-first');
        break;
    }
}

// The quiet line above the rows ("Loading earlier messages\u2026", "Start of the board"), after a poll or a load changed it: its text changes in place, and it goes in or out only when it has something to say.
export function updateBoardHeader(container) {
    const tmp = document.createElement('template');
    tmp.innerHTML = boardHeaderHtml();
    const fresh = tmp.content.querySelector('.mb-earlier-line');
    const line = container.querySelector(':scope > .mb-earlier-line');
    if (line && !fresh) line.remove();
    else if (line) { if (line.outerHTML !== fresh.outerHTML) line.replaceWith(fresh); }
    else if (fresh) container.prepend(fresh);
}

/** "Loading earlier messages\u2026" over the top of the box while a page is out: it takes no room, so the rows do not move when it comes and goes. */
function setEarlierLoading(on) {
    const el = document.getElementById('mb-earlier-loading');
    if (el && el.hidden === on) el.hidden = !on;
    if (on) sayEarlier('Loading earlier messages\u2026');
}

/** What the screen reader hears when earlier messages are added (a status, not a focus move). */
function sayEarlier(text) {
    const el = document.getElementById('mb-earlier-status');
    if (el && el.textContent !== text) el.textContent = text;
}

// The time of a message today, the date and time of an older one: the date said nothing on a board that is read the day it is written (#5991).
export function formatTime(iso) {
    try {
        const d = new Date(iso);
        if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return iso;
    }
}
