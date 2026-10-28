/* The board's poll: new messages while a board is open (moved out of message_board.js, #8399; no behaviour change). */
import { importOnce } from './import_once.js';
import { fetchMessages, PAGE_SIZE, mergeMessages } from './board_fetch.js';
const { isSelectMode } = await importOnce('./board_export.js'); // a part of the board page's group: loaded with it
import { applyAskUpdates, refreshAsk } from './board_table.js';
import { pollEvery } from './overload.js';
import { platform } from './platform/detect.js';
import { bs } from './board_state.js';
const { ROW, appendNewMessages, isAtBottom, renderMessages, updateBoardHeader } = await importOnce('./board_window.js'); // a part of the board page's group: loaded with it
const { loadBoardSubscribers } = await importOnce('./board_members.js'); // a part of the board page's group: loaded with it

let pollTimer = null;

let _pollInFlight = false;

export async function _pollNewMessages() {
    const project = bs.currentProject;
    // Wait for the initial page (an after_id=0 poll would fetch the oldest
    // page), and never run two polls at once.
    if (!project || bs.isPaused || bs._loadedProject !== project || _pollInFlight) return;
    _pollInFlight = true;
    try {
        // What follows the newest message shown.
        const last = bs._allMessages[bs._allMessages.length - 1];
        const result = await fetchMessages(project, PAGE_SIZE, { after_id: last ? last.id : 0 });
        if (bs.currentProject !== project || bs._loadedProject !== project) return;
        // With after_id every returned row is new, even if deletes kept the total flat.
        const fresh = result.messages.filter(m => !last || m.id > last.id);
        if (fresh.length < PAGE_SIZE) {
            // The total should be what was counted plus the new ones; less means messages were deleted (a secret taken down,
            // say), also when one arrived in the same tick. A whole page means more are waiting: counted, checked once caught up.
            if (result.total !== bs._countedTotal + fresh.length) bs._staleRows = true;
            bs._countedTotal = result.total;
        } else {
            bs._countedTotal += fresh.length;
        }
        const totalChanged = bs._totalMessages !== result.total;
        bs._totalMessages = result.total;
        const container = document.getElementById('mb-messages');
        if (bs._staleRows && !isSelectMode() && !bs.pendingMessageId && (!container || isAtBottom(container))) {
            // Rows shown may hold a deleted message: the latest page again. Not while you read higher up, select messages
            // or wait for a search jump; then at a later poll.
            const page = await fetchMessages(project, PAGE_SIZE);
            if (bs.currentProject !== project || bs._loadedProject !== project) return;
            bs._allMessages = page.messages;
            bs._totalMessages = bs._countedTotal = page.total;
            bs._loadedOffset = page.beforeCount;
            bs._staleRows = false;
            renderMessages(bs._allMessages);
            return;
        }
        if (fresh.length > 0) {
            bs._allMessages = mergeMessages(bs._allMessages, fresh);
            for (const p of applyAskUpdates(bs._allMessages, result.askUpdates)) { const row = container && container.querySelector(`:scope > .mb-message[data-message-id="${Number(p.id)}"]`); if (row) refreshAsk(row, p); } // a Question these answer says so now
            appendNewMessages(fresh.length);
        } else if (totalChanged && container && container.querySelector(ROW)) {
            updateBoardHeader(container);
        }
    } catch (e) {
        // Silent fail on poll
    } finally {
        _pollInFlight = false;
    }
}

let _pollCount = 0;

export function startBoardPoll() {
    stopBoardPoll();
    _pollCount = 0;
    pollTimer = pollEvery(() => {
        if (bs.currentProject && (platform.isNative || !document.hidden)) {
            _pollNewMessages();
            // Refresh subscribers less often (every 30s instead of every 10s)
            _pollCount++;
            if (_pollCount % 3 === 0) {
                loadBoardSubscribers(bs.currentProject);
            }
        }
    }, 10000, { whenHidden: true }); // the native app polls while hidden
}

export function stopBoardPoll() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}
