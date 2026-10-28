/* Live history controller: polling, page cursors, cancellation, kept pages and reset. Moved from live_chat.js (#8353). */

import { state } from './state.js';
import { platform } from './platform/detect.js';
import { serverFetch, sessionServer, isCloud } from './server_base.js';
import { pollEvery, isPaused, afterPause, isBusyStatus, busyRetryingText } from './overload.js';
import { backoffTicker } from './poll_backoff.js';
import { rollUpGroups } from './chat_content.js';
import { CHAT_TRIM, FIRST_PAGE } from './chat_page.js';
import { INTERRUPT_RE, noteAgentActivity, noteInterrupt, rememberUserMessage } from './pending_messages.js';
import { renderMessage, renderMessagesChunked } from './chat_messages.js';
import { freshKeptPage, keepFirstPage, keepMore, keptPages } from './chat_kept_pages.js';
import { noteUnseenChat, syncJumpToLatest } from './chat_jump_latest.js';
import { noteReplyText, forgetReplies } from './chat_announce.js';
import { chatParams, _fetchHistoryPage } from './live_history_fetch.js';
import { noteIndexes, stitchPages, _noteReplyState, _syncAfterHistory } from './live_history_render.js';

let historyPollInterval = null;
let historyMessageCount = 0;
let historyStart = 0;       // absolute index of the oldest rendered message (keyset cursor)
let historyHasMore = false;  // whether older messages exist
let initialLoadDone = false; // whether the initial full load has completed
let loadingMore = false;     // an older page is being fetched


// Messages per page. Tool calls and results each count as one and are folded
// away in the chat, so a page covers fewer turns than its size suggests. The
// first page is small so a switch paints quickly (the payload crosses the hub
// leg); older pages load as the reader scrolls toward the top. 30 messages fill
// the view and are about a third of the 100 it was (#3723: 22 to 61 KB against
// 68 to 170 KB on 100 MB transcripts).
const OLDER_PAGE = 200;
// Pages carry at most CHAT_TRIM bytes of each long tool field (an output, a
// written file, an edit): they are folded away, and a card loads its message in
// full when opened (loadTrimmedCard).
// Bumped on reset so responses for a previous session are dropped, and used to
// keep a single refresh in flight: overlapping initial loads would otherwise
// both render the full history.
export let historyGeneration = 0;
let keptRenderGeneration = -1; // the generation whose kept page is being built (refreshLiveHistory)
let refreshInFlight = -1;
let activeChatAbortController = null;
let activeLoadMoreAbortController = null;
/** Shows the kept page of an agent seen a moment ago (built off screen in slices). True when the agent was switched while it was built: the refresh ends. */
async function _showKeptPage(session, container, kept) {
    // Built off screen in slices; a poll that comes while it builds returns at once (keptRenderGeneration).
    const generation = historyGeneration;
    keptRenderGeneration = generation;
    const built = document.createElement("div");
    let rebuilt = false;
    try {
        rebuilt = await renderMessagesChunked(kept.messages, built, session.agent_type, () => generation === historyGeneration);
    } catch (e) {
        // A failed build must not leave the chat blank or the guard set: forget the kept page, and the first page is
        // loaded below as for an agent not seen before.
        console.error("[coral] the kept chat page could not be rebuilt", e);
        keptPages.delete(session.session_id);
    } finally {
        if (!rebuilt && keptRenderGeneration === generation) keptRenderGeneration = -1;
    }
    if (generation !== historyGeneration) return true; // the agent was switched while it built
    if (rebuilt) {
        container.innerHTML = "";
        while (built.firstChild) container.appendChild(built.firstChild);
        historyHasMore = kept.start > 0;
        historyStart = kept.start;
        historyMessageCount = kept.total;
        _updateLoadMoreButton(container);
        initialLoadDone = true;
        if (state.autoScroll) container.scrollTop = container.scrollHeight;
    }
    return false;
}

/** What to ask for: the first page, or only what came after the last message held. */
function _historyParams(session) {
    const params = chatParams(session);

    if (!initialLoadDone) {
        // First load: fetch most recent messages with pagination
        params.set("after", "0");
        params.set("limit", String(FIRST_PAGE));
        params.set("offset", "0");
        params.set("trim", String(CHAT_TRIM));
    } else {
        // Subsequent polls: only fetch new messages
        params.set("after", historyMessageCount);
    }
    return params;
}

/** The messages of the reply: the first page, or the new ones at the bottom, and what each says about the agent. */
function _renderHistoryReply(container, session, data) {
    if (data.messages && data.messages.length > 0) {
        if (!initialLoadDone) {
            container.innerHTML = "";
            noteIndexes(data.messages, data.start);
            // Initial load — render all and add "Load More" button if needed
            for (const msg of data.messages) {
                renderMessage(msg, container, session.agent_type);
            }
            historyHasMore = data.has_more || false;
            historyStart = data.start;
            _updateLoadMoreButton(container);
            initialLoadDone = true;
            keepFirstPage(session.session_id, data.messages, data.total, historyStart);
        } else {
            // Poll — append new messages at the bottom.
            noteUnseenChat(data.messages); // read higher up: counted on the jump-to-latest button
            for (const msg of data.messages) {
                renderMessage(msg, container, session.agent_type);
                if (msg.type === "assistant") noteReplyText(session, msg); // said once when the turn ends (chat_announce.js)
            }
            keepMore(session.session_id, data.messages, data.total);
        }
        for (const msg of data.messages) {
            if (msg.type === "user" && INTERRUPT_RE.test(String(msg.content || "").trim())) noteInterrupt(session.session_id, msg);
            else if (msg.type === "user") rememberUserMessage(session.session_id, msg);
            else noteAgentActivity(session.session_id, msg);
        }
        historyMessageCount = data.total;
    } else if (!initialLoadDone) {
        container.innerHTML = "";
        historyHasMore = false;
        initialLoadDone = true;
        _updateLoadMoreButton(container);
    }
}

/** The first load failed: say so, with Retry. */
function _showHistoryError(container) {
    container.innerHTML = `<div class="chat-load-error" role="alert">
                <span class="chat-error-message">Could not load this conversation. Reload the page to try again.</span>
                <button type="button" class="btn btn-secondary btn-small chat-retry-btn">Retry</button>
            </div>`;
    const retryBtn = container.querySelector('.chat-retry-btn');
    if (retryBtn) {
        retryBtn.onclick = () => {
            container.innerHTML = '<div class="loading-indicator" role="status">Loading conversation…</div>';
            refreshInFlight = -1;
            refreshLiveHistory();
        };
    }
}

export async function refreshLiveHistory() {
    if (!state.currentSession || state.currentSession.type !== "live") return;
    if (!platform.isNative && document.hidden) return;

    const session = state.currentSession;
    if (!session.session_id) return;

    const container = document.getElementById("live-history-messages");
    if (!container) return;

    // An agent seen in the last few minutes: its kept page shows at once, and only what came after is asked for
    // below (a poll from the page's end), not the first page again (#3726).
    if (!initialLoadDone && keptRenderGeneration !== historyGeneration) {
        const kept = freshKeptPage(session.session_id);
        if (kept && await _showKeptPage(session, container, kept)) return;
    }

    // Show loading indicator on first load
    if (!initialLoadDone && !container.querySelector('.loading-indicator') && !container.querySelector('.chat-load-error') && container.children.length === 0) {
        container.innerHTML = '<div class="loading-indicator" role="status">Loading conversation…</div>';
    }

    const params = _historyParams(session);

    if (refreshInFlight === historyGeneration) return;
    const generation = historyGeneration;
    const server = sessionServer(session);
    // The first load during a pause (#3430): the server would refuse it as busy. Say so, and load
    // the moment the pause ends rather than a poll later.
    if (!initialLoadDone && isPaused(server === 'local' ? '' : server)) {
        _showHistoryBusy(container, null, server, generation);
        return;
    }
    refreshInFlight = generation;

    if (activeChatAbortController) {
        activeChatAbortController.abort();
    }
    const abortCtrl = new AbortController();
    activeChatAbortController = abortCtrl;

    try {
        const resp = await _fetchHistoryPage(session, params, server, abortCtrl, initialLoadDone);
        if (generation !== historyGeneration) return;

        // The first load refused as busy (#3430): not an error. Show that it is retrying, and retry
        // once the pause the answer started has run out.
        if (!resp.ok && !initialLoadDone && isBusyStatus(resp.status)) {
            _showHistoryBusy(container, resp, server, generation);
            return;
        }

        if (!resp.ok) {
            let errorText = `HTTP ${resp.status}`;
            try {
                const errData = await resp.json();
                if (errData && errData.error) errorText = errData.error;
            } catch (_) {}
            throw new Error(errorText);
        }

        let data;
        try {
            data = await resp.json();
        } catch (err) {
            // A reply that isn't JSON says so, rather than only a parser's position (#3694).
            throw new Error(`the reply from the server could not be read: ${err.message}`);
        }
        if (generation !== historyGeneration) return;

        // The transcript is shorter than what this client holds (it was cut or replaced while the agent was away, or a kept
        // page outlived it): forget what is shown and load it again from its start.
        if (initialLoadDone && data.total < historyMessageCount) {
            keptPages.delete(session.session_id);
            container.innerHTML = "";
            historyMessageCount = 0;
            historyStart = 0;
            historyHasMore = false;
            initialLoadDone = false;
            setTimeout(refreshLiveHistory, 0); // after this refresh has ended
            return;
        }

        _noteReplyState(session, data);

        _renderHistoryReply(container, session, data);
        _syncAfterHistory(container, session, data);
    } catch (e) {
        if (e.name === 'AbortError') {
            return;
        }
        console.error("Failed to refresh live history:", e);
        if (generation === historyGeneration && !initialLoadDone) {
            _showHistoryError(container);
        }
    } finally {
        if (activeChatAbortController === abortCtrl) {
            activeChatAbortController = null;
        }
        if (refreshInFlight === generation) refreshInFlight = -1;
    }
}

// A first history load refused as busy, or due during a pause: "Loading… (Coral Hub busy,
// retrying)" in place of the loading line, and the load again as soon as the pause is over, for
// the same agent only. One retry is queued at a time; the 1 s poll covers it too.
let _historyBusyRetry = null;
function _showHistoryBusy(container, resp, server, generation) {
    let el = container.querySelector(':scope > .loading-indicator');
    if (!el) {
        container.innerHTML = '<div class="loading-indicator"></div>';
        el = container.querySelector(':scope > .loading-indicator');
    }
    el.classList.add('chat-history-busy');
    el.setAttribute('role', 'status');
    el.textContent = busyRetryingText(resp, { machine: server, hub: isCloud() });
    if (_historyBusyRetry) clearTimeout(_historyBusyRetry);
    _historyBusyRetry = afterPause(() => {
        _historyBusyRetry = null;
        if (generation === historyGeneration && !initialLoadDone) refreshLiveHistory();
    }, server);
}

/** Load older messages (prepend above current messages). */
/** True while older transcript pages remain unloaded (used by find-in-chat). */
export function chatHasOlder() { return historyHasMore; }

/** The button at the top of the chat says it is loading while an older page is fetched (#10050: after a reload the history fills in from the top and nothing said so), and has its words back after. */
function sayLoadingEarlier(on) {
    const btn = document.querySelector("#live-history-messages > .load-more-btn");
    if (!btn) return;
    const text = on ? "Loading earlier messages\u2026" : "Load older messages";
    if (btn.textContent !== text) btn.textContent = text;
    if (on) btn.setAttribute("aria-busy", "true"); else btn.removeAttribute("aria-busy");
}

export async function loadMoreHistory() {
    if (!state.currentSession || !historyHasMore || loadingMore) return;
    loadingMore = true;
    const generation = historyGeneration;
    let ok = false;
    sayLoadingEarlier(true);
    try {
        ok = await _loadMoreHistory(generation);
    } finally {
        if (generation === historyGeneration) loadingMore = false;
        sayLoadingEarlier(false);
    }
    // A page shorter than the view leaves the sentinel in sight, and the
    // observer only reports changes: keep loading while it is still within
    // reach. Measured, because the observer's entry for the prepend has not
    // been delivered yet.
    if (ok && generation === historyGeneration && historyHasMore && sentinelInReach()) {
        loadMoreHistory();
    }
    // Re-arm the observer: observe() reports the current state, so a reader
    // who left and came back to the top while the page loaded is not stuck.
    if (ok && generation === historyGeneration && sentinelObserver) {
        const btn = document.querySelector("#live-history-messages > .load-more-btn");
        if (btn) {
            sentinelObserver.unobserve(btn);
            sentinelObserver.observe(btn);
        }
    }
}

function sentinelInReach() {
    const container = document.getElementById("live-history-messages");
    const btn = container && container.querySelector(":scope > .load-more-btn");
    if (!btn || !container.clientHeight) return false;
    return btn.getBoundingClientRect().bottom >= container.getBoundingClientRect().top - AUTO_LOAD_PX;
}

/** Save for Later's jump (#4510): page up until the message with this key (whose index in the transcript is index) is on screen, then show it:
 *  open the steps it sits in, scroll it to the middle, mark it and give it the focus. Resolves false when it is not there. */
export async function jumpToLiveMessage(key, index) {
    const container = document.getElementById("live-history-messages");
    if (!container) return false;
    const find = () => container.querySelector(`[data-msg-key="${CSS.escape(key)}"]`);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 80 && !(initialLoadDone && container.querySelector("[data-msg-key]")); i++) await pause(100); // the agent's newest page first
    for (let guard = 0; guard < 400 && !find() && historyHasMore && historyStart > index; guard++) {
        if (loadingMore) { await pause(50); continue; }
        const generation = historyGeneration;
        loadingMore = true;
        try {
            if (!(await _loadMoreHistory(generation))) break;
        } finally {
            if (generation === historyGeneration) loadingMore = false;
        }
    }
    const target = find();
    if (!target) return false;
    for (let d = target.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
    for (const old of container.querySelectorAll(".chat-search-target")) old.classList.remove("chat-search-target");
    target.classList.add("chat-search-target");
    target.scrollIntoView({ block: "center" });
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    return true;
}

async function _loadMoreHistory(generation) {

    const session = state.currentSession;
    const container = document.getElementById("live-history-messages");
    if (!container) return;

    const params = chatParams(session);
    // Pagination is anchored by the cursor; omit an explicit after=0 so
    // providers and test harnesses can distinguish load-more from initial load.
    // before= is the oldest rendered message's absolute index, so messages
    // appended since the first page do not shift the window.
    params.set("limit", String(OLDER_PAGE));
    params.set("trim", String(CHAT_TRIM));
    params.set("before", String(historyStart));
    const server = sessionServer(session);

    if (activeLoadMoreAbortController) {
        activeLoadMoreAbortController.abort();
    }
    const abortCtrl = new AbortController();
    activeLoadMoreAbortController = abortCtrl;

    try {
        const url = () => `/api/sessions/live/${encodeURIComponent(session.name)}/chat?${params}`;
        const resp = await serverFetch(server, url(), { signal: abortCtrl.signal });
        if (generation !== historyGeneration) return; // switched agents meanwhile
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (generation !== historyGeneration) return;

        if (data.messages && data.messages.length > 0) {
            const temp = document.createElement("div");
            noteIndexes(data.messages, data.start);
            if (!await renderMessagesChunked(data.messages, temp, session.agent_type, () => generation === historyGeneration)) return;

            // Preserve scroll position: measure just before inserting
            const prevScrollHeight = container.scrollHeight;
            const prevScrollTop = container.scrollTop;

            // Find the insertion point (after the Load More button)
            const loadMoreBtn = container.querySelector(".load-more-btn");
            const refNode = loadMoreBtn ? loadMoreBtn.nextSibling : container.firstChild;

            const lastOlder = temp.lastElementChild;
            while (temp.firstChild) {
                container.insertBefore(temp.firstChild, refNode);
            }
            stitchPages(lastOlder);
            rollUpGroups(container);

            historyStart = data.start;
            historyHasMore = (data.has_more || false) && historyStart > 0;

            // Restore scroll position so the view doesn't jump
            container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
        } else {
            historyHasMore = false;
        }

        _updateLoadMoreButton(container);
        return true;
    } catch (e) {
        if (e.name === 'AbortError') return false;
        console.error("Failed to load more history:", e);
        return false;
    } finally {
        if (activeLoadMoreAbortController === abortCtrl) {
            activeLoadMoreAbortController = null;
        }
    }
}

// The button at the top of the chat is also the autoload sentinel: when it
// comes within AUTO_LOAD_PX of the visible area, the next older page loads.
// The button stays for find-in-chat and for when a load failed.
const AUTO_LOAD_PX = 200;
let sentinelObserver = null;

function observeSentinel(container, btn) {
    if (typeof IntersectionObserver === "undefined") return;
    if (sentinelObserver && sentinelObserver.root !== container) {
        sentinelObserver.disconnect();
        sentinelObserver = null;
    }
    if (!sentinelObserver) {
        sentinelObserver = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting && historyHasMore && initialLoadDone) loadMoreHistory();
            }
        }, { root: container, rootMargin: `${AUTO_LOAD_PX}px 0px 0px 0px` });
    }
    sentinelObserver.observe(btn);
}

function _updateLoadMoreButton(container) {
    let btn = container.querySelector(".load-more-btn");
    if (historyHasMore) {
        if (!btn) {
            btn = document.createElement("button");
            btn.className = "btn load-more-btn chat-history-sentinel";
            btn.textContent = "Load older messages";
            btn.onclick = loadMoreHistory;
            container.insertBefore(btn, container.firstChild);
            observeSentinel(container, btn);
        }
    } else if (btn) {
        if (sentinelObserver) sentinelObserver.unobserve(btn);
        btn.remove();
    }
}

// Returns the first load, so a caller can hold slower work (the git/file
// queries) until the transcript is in. The browser allows only a handful of
// connections per origin, and on a big repo those queries are seconds long.
export function startLiveHistoryPoll() {
    stopLiveHistoryPoll();
    const firstLoad = refreshLiveHistory();
    // The chat is read every second while it changes and less and less often while it does not (poll_backoff.js: 1 s, then up to 10 s); a key press, a click, the window or the agent page coming back puts it
    // back to every second (#9101: 49 requests in 30 s for one open agent that was saying nothing).
    const ticker = backoffTicker(document, async () => { const before = historyMessageCount; await refreshLiveHistory(); return historyMessageCount !== before; });
    historyPollInterval = pollEvery(ticker.tick, 1000, { machine: () => state.currentSession && sessionServer(state.currentSession), agentView: true });
    stopWake = () => { ticker.stop(); stopWake = null; };
    return firstLoad;
}
let stopWake = null;

export function stopLiveHistoryPoll() {
    if (stopWake) stopWake();
    if (historyPollInterval) {
        clearInterval(historyPollInterval);
        historyPollInterval = null;
    }
    if (activeChatAbortController) {
        activeChatAbortController.abort();
        activeChatAbortController = null;
    }
}

// Reset transcript state when the selected live session changes. A restart
// keeps the same pane but allocates a new Coral session ID; callers can ask us
// to resume an already-running poll so the new transcript is loaded from zero.
export function resetLiveHistory({ resume = false } = {}) {
    if (!resume) forgetReplies(); // another agent: what was waiting to be said belongs to the one before
    const wasPolling = !!historyPollInterval;
    stopLiveHistoryPoll();
    // Free the connections of the previous chat's fetches right away: through
    // the hub, a switch otherwise queues behind them.
    if (activeLoadMoreAbortController) {
        activeLoadMoreAbortController.abort();
        activeLoadMoreAbortController = null;
    }
    if (activeChatAbortController) {
        activeChatAbortController.abort();
        activeChatAbortController = null;
    }
    if (sentinelObserver) {
        sentinelObserver.disconnect();
        sentinelObserver = null;
    }
    const container = document.getElementById("live-history-messages");
    if (container) container.innerHTML = "";
    historyGeneration++;
    refreshInFlight = -1;
    // A new chat opens at the bottom. Only scroll events set autoScroll, and
    // the one emptying the container fires after the first page renders.
    state.autoScroll = true;
    syncJumpToLatest(); // the emptied chat is at its bottom: no button, no count from the agent before
    historyMessageCount = 0;
    historyStart = 0;
    historyHasMore = false;
    initialLoadDone = false;
    loadingMore = false;
    if (resume) {
        if (wasPolling) startLiveHistoryPoll();
    }
}
