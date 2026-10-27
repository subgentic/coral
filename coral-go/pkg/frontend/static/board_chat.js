import { openTask } from './task_navigation.js';
/* Moved out of render.js as it was (#3795): no behaviour change. */
import { formatHourMinute } from './format.js';
import { morphHtml } from './dom_morph.js';
import { OPERATOR_ID, isOperatorId, escapeHtml, showToast, escapeAttr, getAgentColor, askBadge, externalMessageBadge, replyWithHtml, hubUserBadge, renderBoardMessageBody, setBoardMentionNames, highlightMentionsIn, boardMessageColorStyle } from './utils.js';
import { splitKey, keyLabel, boardFetch } from './server_base.js';
import { groupTaskQueueRuns, renderTaskQueueRun } from './board_system_lines.js';
import { messageAttachmentAttrs, messageAttachmentsHtml } from './board_attachments.js';
import { pollEvery } from './overload.js';
import { resolveBoardArtifacts } from './board_artifacts.js';
import { initGrowingTextarea } from './growing_textarea.js';
import { announceNotice } from './notifications.js';
import { outcomeUnknownLine } from './outcome_unknown.js';
import { paintPauseButton as _paintPauseButton } from './board_pause_button.js';
import { setAllRows, applyAskUpdates, onRowActions, boardView, saveBoardView, rowParts, applyView, mountTableTools, forgetOpenRows, refreshReplies, retagMentions, watchFold, dayLineBefore } from './board_table.js'; // the Board as a table (#7922): the team page's module at dock width
import { messageTimeHtml } from './message_time.js';
import { keyRoute, build } from './routes.js';
import { browserLocal } from './safe_storage.js';
import { createBoardSearch } from './board_search.js';
import { menuMove } from './menu_keys.js';

// ── Board (right-panel tab) ──────────────────────────────────────
let _boardChatTimer = null;
let _activeBoardChat = null;
let _boardChatGen = 0;   // bumped whenever the board chat panel is rebuilt, to drop stale loads

/** The board whose chat the panel currently shows (or null). */
export function getActiveBoardChat() { return _activeBoardChat; }
let _boardChatMessages = [];
let _boardChatTotal = 0;
let _boardChatOffset = 0;   // older messages not loaded yet
// The board the message state above belongs to, and whether its latest page has loaded. The state
// outlives the panel, so switching between agents of one board doesn't load the page again (#3722).
let _boardChatBoard = null;
let _boardChatLoaded = false;
let _boardChatInFlight = 0;   // the panel generation whose load is in flight (0: none)
let _boardChatAgain = false;  // a load was asked for while one was in flight (after a send)
const _BOARD_CHAT_PAGE = 50;
// The panel keeps the newest _BOARD_CHAT_KEEP messages while the reader is at the bottom (#4318): a tab
// left open on a busy board kept every message it ever received and re-templated all of them for each
// new one. Older messages stay behind "Load earlier". The list is cut back a page at a time, so it is
// rebuilt once per page of new messages, not shifted on every one.
const _BOARD_CHAT_KEEP = 300;
let _boardChatSelectMode = false;
let _boardChatSelectedIds = new Set();

// An agent's dock shows what that agent would read (#8484): the messages its read delivers (its @mentions, @all and the rest of the server's one rule), asked of the board with for_subscriber.
// The Orchestrator's dock, and an agent with no member id, shows the whole board; the team page's Board tab is the whole board for everyone.
const SCOPE_KEY = 'coral.board.scope'; // the removed "For this agent | Whole board" choice (#8930): forgotten from the browser when a dock is drawn
let _boardChatScope = '';      // the member whose read the list is (empty: the whole board)
let _boardChatReader = null;   // { id, name } the dock's agent as a board member, or null when its dock shows the whole board
let _boardChatBoardTotal = 0;  // the whole board's count, beside the reader's own
const scopeQuery = () => (_boardChatScope ? `&for_subscriber=${encodeURIComponent(_boardChatScope)}` : '');

// The dock's search is the board page's search bar in its own instance (board_search.js), asking for the same list the dock shows: for the agent's list, the matches are the search and that list together.
const _dockSearch = createBoardSearch('bd');
const _dockSearchHooks = {
    me: OPERATOR_ID,
    scope: () => _boardChatScope,
    redraw: () => _dockSearch.highlight(document.getElementById('board-panel-msgs')),
    jumpTo: id => _dockJumpTo(id),
    first: async () => { await _dockLoadAllEarlier(); const box = document.getElementById('board-panel-msgs'); if (box) box.scrollTop = 0; },
    latest: () => { const box = document.getElementById('board-panel-msgs'); if (box) box.scrollTop = box.scrollHeight; },
    expandAll: () => setAllRows(document.getElementById('board-panel-msgs'), true),
    collapseAll: () => setAllRows(document.getElementById('board-panel-msgs'), false),
    noMatch: () => (_boardChatScope && _boardChatReader ? { text: `No match in what ${_boardChatReader.name} reads` } : null),
};

// What a rebuild used to reset and a kept panel must reset itself on a switch: select mode, an open @-mention list, the title.
function _resetBoardPanelForSwitch(panel, boardName) {
    if (_boardChatSelectMode) {
        const btn = panel.querySelector('.board-select-btn');
        if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-pressed', 'false'); }
        const inputPane = document.getElementById('board-chat-input-pane');
        if (inputPane) inputPane.style.display = '';
        const bar = document.getElementById('board-chat-select-bar');
        if (bar) bar.style.display = 'none';
    }
    const mention = document.getElementById('board-mention-dropdown');
    if (mention && mention.style.display !== 'none') mention.style.display = 'none';
    const title = panel.querySelector('.board-chat-title');
    const label = keyLabel(boardName);
    if (title && title.textContent !== label) title.textContent = label;
}

export function showBoardChatTab(boardName, agent = null) {
    _activeBoardChat = boardName;
    _boardChatReader = agent && agent.subscriber && !agent.orchestrator ? { id: String(agent.subscriber), name: agent.name || String(agent.subscriber) } : null;
    browserLocal.remove(SCOPE_KEY);
    const scope = _boardChatReader ? _boardChatReader.id : '';
    ++_boardChatGen;
    const panel = document.getElementById('agentic-panel-board');
    if (!panel) return;

    // The same board again (another agent of its team): the panel is kept as it is, header, messages and input pane, so a draft in
    // the textarea survives the switch and nothing is rebuilt (#3898; before, every switch rebuilt the panel and wiped the draft).
    // A different board, or a panel that was cleared, is built afresh.
    const sameBoard = _boardChatBoard === boardName && panel.dataset.board === boardName
        && !!panel.querySelector('#board-panel-msgs') && !!panel.querySelector('#board-panel-input');
    if (sameBoard) {
        _resetBoardPanelForSwitch(panel, boardName);
    } else {
        // The same board again (another agent of its team): the messages element, with its rendered messages, is carried over into
        // the rebuilt panel, so the render below keeps those nodes instead of building them again (#3881).
        const carried = _boardChatLoaded && _boardChatBoard === boardName && _boardChatScope === scope ? document.getElementById('board-panel-msgs') : null;
        if (carried) carried.remove();

        // Populate the board tab content (visibility managed by switchAgenticTab)
        panel.innerHTML = `
            <div class="board-chat-header">
                <a class="board-chat-title" href="#" data-on-click="board-chat-open" data-board="${escapeAttr(boardName)}" title="Open full board view">${escapeHtml(keyLabel(boardName))}</a>
                <button class="btn-nav board-icon-btn" id="board-chat-pause-btn" data-on-click="board-chat-pause" data-board="${escapeAttr(boardName)}" aria-label="Pause board" title="Pause board: stops agents from receiving new messages until resumed"><span class="material-icons" aria-hidden="true">pause</span></button>
                <button class="btn-nav board-select-btn board-icon-btn" data-on-click="board-chat-select" aria-label="Export messages" aria-pressed="false" title="Export: select messages to export as Markdown"><span class="material-icons" aria-hidden="true">download</span></button>
            </div>
            <div class="notice notice-error notice-bar notice-center board-paused-banner" id="board-chat-paused-banner" style="display:none">Board reads are paused — agents cannot see new messages</div>
            <div class="board-chat-msgs-wrap">
                <div id="board-chat-earlier-status" class="sr-only" role="status" aria-live="polite"></div><!-- #7762: "50 earlier messages loaded" -->
                <div id="board-chat-loading" class="mb-earlier-loading" hidden aria-hidden="true">Loading earlier messages&hellip;</div>
                <div class="board-chat-messages" id="board-panel-msgs"></div>
            </div>
            <div class="board-chat-input-pane" id="board-chat-input-pane">
                <div class="command-pane-body">
                    <div class="command-editor board-chat-editor-wrap">
                        <textarea class="board-chat-textarea" id="board-panel-input" rows="1" placeholder="Message the team... (@ to mention)" aria-label="Message the team"
                            role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="board-mention-dropdown"
                            data-on-keydown="board-chat-key" data-on-input="board-chat-mention" data-board="${escapeAttr(boardName)}"></textarea>
                        <div class="board-mention-dropdown" id="board-mention-dropdown" role="listbox" aria-label="Mention an agent" style="display:none"></div>
                    </div>
                </div>
                <!-- After the text box in the DOM so Tab reaches the box first, then @all, then Send; CSS order draws them under it, as the chat's composer does -->
                <div class="toolbar toolbar-pad command-pane-toolbar board-chat-toolbar">
                    <button type="button" class="btn-nav board-mention-chip" data-on-click="board-chat-all" title="Notify all agents">@all</button>
                    <span class="toolbar-spacer"></span>
                    <button type="button" class="btn-nav btn-send" data-on-click="board-chat-send" data-board="${escapeAttr(boardName)}" aria-label="Send message" title="Send message (Enter)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                    </button>
                </div>
            </div>`;

        if (carried) document.getElementById('board-panel-msgs').replaceWith(carried);

        initGrowingTextarea(document.getElementById('board-panel-input'));
        mountDockTableSwitch(panel);

    panel.dataset.board = boardName;
    }

    // A new board, or another reader of it, starts afresh; the same board shows what it had at once, and the poll fetches
    // only what came since.
    if (_boardChatBoard !== boardName || _boardChatScope !== scope) {
        _boardChatBoard = boardName;
        _boardChatScope = scope;
        _boardChatBoardTotal = 0;
        forgetOpenRows(); // no row stays open across teams
        _boardChatReplyTo = null;
        _boardChatLoaded = false;
        _boardChatMessages = [];
        _boardChatTotal = 0;
        _boardChatOffset = 0;
    }
    _boardChatSelectMode = false;
    _boardChatSelectedIds.clear();
    _syncScopeBar(panel);
    _mountDockSearch(panel, boardName);
    if (_boardChatLoaded) _renderBoardPanelMessages(document.getElementById('board-panel-msgs'), true);

    _loadBoardPanelChat(boardName);
    _checkBoardPauseState(boardName);
    // Start polling
    if (_boardChatTimer) clearInterval(_boardChatTimer);
    // Unread counts and notifications keep a slow beat (30 s) while the agent's page is off screen (#3719).
    _boardChatTimer = pollEvery(() => _loadBoardPanelChat(boardName), 3000, { whenHidden: true, agentView: 30000 });
}

export function hideBoardChatTab() {
    _dockSearch.reset();
    _activeBoardChat = null;
    ++_boardChatGen;
    _boardChatSelectMode = false;
    _boardChatSelectedIds.clear();
    if (_boardChatTimer) { clearInterval(_boardChatTimer); _boardChatTimer = null; }
    const panel = document.getElementById('agentic-panel-board');
    if (panel) panel.innerHTML = '';
}

function _formatTime(iso) {
    if (!iso) return '';
    return formatHourMinute(new Date(iso));
}

// Loads what's new on the board into the panel. Once the latest page is in, the board is asked
// only for the messages after the newest one shown (after_id), so a steady poll costs one small
// request that returns nothing (#3722). The latest page is loaded again when the total says
// messages were deleted, or a page or more arrived at once.
async function _loadBoardPanelChat(boardName, { full = false } = {}) {
    if (!document.getElementById('board-panel-msgs')) return;
    // Rapid agent/team switching rebuilds the panel while requests are in flight;
    // a response for an older panel must never touch the shared message state.
    const gen = _boardChatGen;
    const stale = () => gen !== _boardChatGen || _activeBoardChat !== boardName;
    _syncMentionNames(boardName); // the board's members, for the @mentions in its messages
    if (_boardChatInFlight === gen) { _boardChatAgain = true; return; } // one at a time, then once more
    _boardChatInFlight = gen;
    _boardChatAgain = false;
    try {
        const loaded = !full && _boardChatLoaded && _boardChatBoard === boardName;
        if (loaded) {
            const last = _boardChatMessages[_boardChatMessages.length - 1];
            const afterId = last ? last.id : 0;
            const resp = await boardFetch(boardName, `/messages/all?limit=${_BOARD_CHAT_PAGE}&after_id=${encodeURIComponent(afterId)}&format=dashboard${scopeQuery()}`);
            if (!resp.ok) return;
            const data = await resp.json();
            if (stale()) return;
            const fresh = (Array.isArray(data?.messages) ? data.messages : []).filter(m => m.id > afterId);
            const expected = _boardChatTotal + fresh.length;
            // The total must be exactly what the panel counts plus the new ones: a message deleted in
            // the same tick as one arrives (a secret, say) still makes it reload, and goes within a poll.
            if (fresh.length < _BOARD_CHAT_PAGE && Number(data.total) === expected) {
                if (!fresh.length) return;
                const byId = new Map([..._boardChatMessages, ...fresh].map(m => [m.id, m]));
                _boardChatMessages = [...byId.values()].sort((a, b) => a.id - b.id);
                applyAskUpdates(_boardChatMessages, data.ask_updates); // a Question these answer says so in the render below (the server's word, #8200)
                _boardChatTotal = expected;
                if (data.board_total !== undefined) _boardChatBoardTotal = Number(data.board_total) || 0;
                const el = document.getElementById('board-panel-msgs');
                _trimBoardChatWindow(el);
                if (el) _renderBoardPanelMessages(el, false);
                return;
            }
            // Deleted messages, or a page or more at once.
        }

        // The latest page (offset=0: no OFFSET scan).
        const resp = await boardFetch(boardName, `/messages/all?limit=${_BOARD_CHAT_PAGE}&offset=0&format=dashboard${scopeQuery()}`);
        if (!resp.ok) return; // a refusal is not an empty board
        const data = await resp.json();
        if (stale()) return;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const total = Number(data.total) || 0;
        const first = !(_boardChatLoaded && _boardChatBoard === boardName);

        _boardChatBoard = boardName;
        _boardChatMessages = messages;
        _boardChatTotal = total;
        _boardChatBoardTotal = Number(data.board_total) || 0;
        _boardChatOffset = Number(data.before_count) || 0;
        _boardChatLoaded = true;

        const el = document.getElementById('board-panel-msgs');
        if (!el) return;
        _renderBoardPanelMessages(el, first);
    } catch { /* ignore */ } finally {
        if (_boardChatInFlight === gen) {
            _boardChatInFlight = 0;
            if (_boardChatAgain && !stale()) { _boardChatAgain = false; _loadBoardPanelChat(boardName); }
        }
    }
}

// Drops the oldest messages beyond _BOARD_CHAT_KEEP (they count as not loaded, so "Load earlier"
// brings them back), unless the reader is scrolled up among them or selecting messages to export.
function _trimBoardChatWindow(msgsEl) {
    if (_boardChatSelectMode || _boardChatMessages.length <= _BOARD_CHAT_KEEP + _BOARD_CHAT_PAGE) return;
    if (msgsEl && msgsEl.scrollTop < msgsEl.scrollHeight - msgsEl.clientHeight - 20) return;
    const drop = _boardChatMessages.length - _BOARD_CHAT_KEEP;
    _boardChatMessages = _boardChatMessages.slice(drop);
    _boardChatOffset += drop;
}

// Earlier messages load by themselves when the reader scrolls near the top (#7762, as the team page's Messages tab does): no button and no count. "Loading earlier messages..." floats over the
// top of the list while a page is out (it takes no room, so nothing shifts), a screen reader hears how many were added, and "Start of the board" is the list's first line once the first message is loaded.
let _boardChatEarlierBusy = false;

function _sayBoardChatEarlier(text) {
    const el = document.getElementById('board-chat-earlier-status');
    if (el && el.textContent !== text) el.textContent = text;
}

function _setBoardChatLoading(on) {
    const el = document.getElementById('board-chat-loading');
    if (el && el.hidden === on) el.hidden = !on;
    if (on) _sayBoardChatEarlier('Loading earlier messages\u2026');
}

/** A list the loaded messages do not fill has nothing to scroll: the page before loads without a scroll event. */
function _fillBoardChatTop(msgsEl) {
    if (msgsEl && msgsEl.clientHeight > 0 && _boardChatOffset > 0 && !_boardChatEarlierBusy && msgsEl.scrollHeight <= msgsEl.clientHeight + 80) _loadEarlierBoardChat();
}

function _wireBoardChatScroll(msgsEl) {
    if (msgsEl._bcScrollWired) return;
    msgsEl._bcScrollWired = true;
    msgsEl.addEventListener('scroll', () => { if (msgsEl.scrollTop < 80 && _boardChatOffset > 0) _loadEarlierBoardChat(); }, { passive: true });
}

async function _loadEarlierBoardChat() {
    if (!_activeBoardChat || _boardChatOffset <= 0 || !_boardChatMessages.length || _boardChatEarlierBusy) return;
    const msgsEl = document.getElementById('board-panel-msgs');
    if (!msgsEl) return;
    const boardName = _activeBoardChat;
    const gen = _boardChatGen;
    _boardChatEarlierBusy = true;
    _setBoardChatLoading(true);
    try {
        const resp = await boardFetch(boardName, `/messages/all?limit=${_BOARD_CHAT_PAGE}&before_id=${encodeURIComponent(_boardChatMessages[0].id)}&format=dashboard${scopeQuery()}`);
        if (!resp.ok) return;
        const data = await resp.json();
        // The panel may have switched boards or reloaded while this was in flight.
        if (gen !== _boardChatGen || _activeBoardChat !== boardName) return;
        const messages = Array.isArray(data.messages) ? data.messages : [];

        // Save scroll height to preserve position after prepending
        const prevScrollHeight = msgsEl.scrollHeight;

        const had = _boardChatMessages.length;
        const byId = new Map([...messages, ..._boardChatMessages].map(m => [m.id, m]));
        _boardChatMessages = [...byId.values()].sort((a, b) => a.id - b.id);
        _boardChatOffset = Number(data.before_count) || 0;

        _renderBoardPanelMessages(msgsEl, false);

        // Restore scroll position so user stays where they were
        msgsEl.scrollTop = msgsEl.scrollHeight - prevScrollHeight;
        const added = _boardChatMessages.length - had;
        _sayBoardChatEarlier(added > 0 ? `${added} earlier message${added === 1 ? '' : 's'} loaded${_boardChatOffset <= 0 ? '. This is the start of the board' : ''}.` : '');
    } catch { /* ignore */ } finally {
        _boardChatEarlierBusy = false;
        _setBoardChatLoading(false);
        _fillBoardChatTop(msgsEl);
    }
}
(window.__coral ||= {})._loadEarlierBoardChat = _loadEarlierBoardChat;
/** Tests: how many messages the panel holds and how many of the board are not loaded yet. */
(window.__coral ||= {}).boardChatCounts = () => ({ shown: _boardChatMessages.length, notLoaded: _boardChatOffset });

/** An empty board says what to do next (#5989): tell the lead what to build, the agent named Orchestrator, else the board's first member; the compose box is focused by the caller. */
function _emptyBoardLine() {
    const subs = (_boardSubscribers[_activeBoardChat] || []).filter(s => !isOperatorId(s.subscriber_id));
    const lead = subs.find(s => (s.job_title || s.subscriber_id) === 'Orchestrator') || subs[0];
    return lead ? `Tell @${lead.job_title || lead.subscriber_id} what to build` : 'No messages on the board yet';
}

function _renderBoardPanelMessages(msgsEl, scrollToBottom) {
    if (!msgsEl) return;
    const messages = _boardChatMessages;
    if (!messages.length && _boardChatOffset <= 0) {
        if (_boardChatScope && _boardChatReader) msgsEl.innerHTML = `<div class="empty-state empty-state-tight">${escapeHtml(`Nothing for ${_boardChatReader.name} yet.`)}</div>`; // nothing for this agent yet
        else msgsEl.innerHTML = `<div class="empty-state empty-state-tight">${escapeHtml(_emptyBoardLine())}</div>`;
        msgsEl.dataset.rendered = '1';
        _syncScopeNote();
        return;
    }
    const wasAtBottom = scrollToBottom || msgsEl.scrollTop >= msgsEl.scrollHeight - msgsEl.clientHeight - 20;

    // No "Load earlier" button or count (#7762): earlier messages load on scroll-up. Once the board's first message is loaded, a quiet line says so.
    const loadEarlierHtml = _boardChatOffset <= 0 ? '<div class="mb-earlier-line">Start of the board</div>' : '';
    _wireBoardChatScroll(msgsEl);

    // Runs of task-queue lines are one collapsed row (#3343), except in select mode.
    const items = groupTaskQueueRuns(messages, !_boardChatSelectMode);
    // Unchanged messages keep their nodes (and the artifact images and links already resolved in them); only new or changed ones
    // are built (#3881: the whole page was rebuilt on every agent switch, 170 to 200 ms over five switches).
    const lastWhen = (it) => it.kind === 'queue' ? it.msgs[it.msgs.length - 1].created_at : it.m.created_at;
    applyView(msgsEl, boardView());
    watchFold(msgsEl, { always: true }); // the dock is narrow: its rows are always the folded two lines
    morphHtml(msgsEl, loadEarlierHtml + items.map((item, i) => {
        const day = dayLineBefore(item.kind === 'queue' ? item.msgs[0].created_at : item.m.created_at, i > 0 ? lastWhen(items[i - 1]) : null);
        if (item.kind === 'queue') return day + renderTaskQueueRun(item, _formatTime);
        const m = item.m;
        const agent = m.job_title || m.sender_name || 'Unknown';
        const color = getAgentColor(agent);
        const prev = i > 0 && items[i - 1].kind === 'msg' ? items[i - 1].m : null;
        const prevAgent = prev ? (prev.job_title || prev.sender_name || 'Unknown') : null;
        const sameAsPrev = agent === prevAgent;
        const spacing = sameAsPrev ? 'mb-message-grouped' : 'mb-message-first';
        const isLeader = /orchestrator/i.test(agent) || isOperatorId(m.subscriber_id || m.session_id);
        const alignClass = isLeader ? ' board-msg-left' : ' board-msg-right';

        const selectedClass = _boardChatSelectMode && _boardChatSelectedIds.has(m.id) ? ' mb-message-selected' : '';
        const checkbox = _boardChatSelectMode ? `<input type="checkbox" class="check mb-select-checkbox" data-msg-id="${Number(m.id)}" ${_boardChatSelectedIds.has(m.id) ? 'checked' : ''} data-on-click="board-chat-msg-select">` : '';
        const parent = m.reply_to ? messages.find(x => x.id === m.reply_to) : null;
        const parts = rowParts(m, { agent, timeHtml: messageTimeHtml(m.created_at), moreLabel: '', replyName: m.reply_to ? (parent ? (parent.job_title || parent.sender_name || 'Unknown') : 'an earlier message') : '', more: false, idp: 'dbd' });
        return day + `<div class="mb-message ${spacing}${alignClass}${selectedClass}${parts.classes}"${parts.attrs} data-message-id="${Number(m.id)}"${m.reply_to ? ` data-reply-to="${Number(m.reply_to)}"` : ''}${messageAttachmentAttrs(m)} style="${boardMessageColorStyle(color)}">
            ${parts.toggle}
            <div class="mb-message-header">
                ${checkbox}
                <span class="mb-agent-name">${m.icon ? escapeHtml(m.icon) + ' ' : ''}${escapeHtml(agent)}</span>
                ${externalMessageBadge(m)}${hubUserBadge(m)}${askBadge(m)}
                <span class="mb-message-time">${_formatTime(m.created_at)}</span>
            </div>
            ${parts.tagsOpen}
            <div class="prose mb-message-body" id="${escapeAttr(parts.bodyId)}">${renderBoardMessageBody(m)}</div>
            ${messageAttachmentsHtml(m)}
            ${replyWithHtml(m)}
            ${parts.actions}
        </div>`;
    }).join(''));
    refreshReplies(msgsEl);
    resolveBoardArtifacts(msgsEl, _activeBoardChat ? splitKey(_activeBoardChat).server : undefined);
    if (wasAtBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
    msgsEl.dataset.rendered = '1';
    _syncScopeNote();
    _dockSearch.highlight(msgsEl);
    _fillBoardChatTop(msgsEl);
    // Update select bar if in select mode
    if (_boardChatSelectMode) _updateBoardChatSelectBar();
}

function _toggleBoardChatSelect() {
    _boardChatSelectMode = !_boardChatSelectMode;
    _boardChatSelectedIds.clear();
    const btn = document.querySelector('.board-select-btn');
    if (btn) { btn.classList.toggle('active', _boardChatSelectMode); btn.setAttribute('aria-pressed', String(_boardChatSelectMode)); }
    // Hide chat input when in select mode
    const inputPane = document.getElementById('board-chat-input-pane');
    if (inputPane) inputPane.style.display = _boardChatSelectMode ? 'none' : '';
    _updateBoardChatSelectBar();
    const msgsEl = document.getElementById('board-panel-msgs');
    if (msgsEl) _renderBoardPanelMessages(msgsEl, false);
}
(window.__coral ||= {})._toggleBoardChatSelect = _toggleBoardChatSelect;

export function _toggleBoardChatMsgSelect(msgId, checked) {
    if (checked) {
        _boardChatSelectedIds.add(msgId);
    } else {
        _boardChatSelectedIds.delete(msgId);
    }
    const cb = document.querySelector(`#board-panel-msgs .mb-select-checkbox[data-msg-id="${msgId}"]`);
    if (cb) cb.closest('.mb-message').classList.toggle('mb-message-selected', checked);
    _updateBoardChatSelectBar();
}

export function _boardChatSelectAll() {
    _boardChatMessages.forEach(m => _boardChatSelectedIds.add(m.id));
    const msgsEl = document.getElementById('board-panel-msgs');
    if (msgsEl) _renderBoardPanelMessages(msgsEl, false);
}

export function _boardChatSelectNone() {
    _boardChatSelectedIds.clear();
    const msgsEl = document.getElementById('board-panel-msgs');
    if (msgsEl) _renderBoardPanelMessages(msgsEl, false);
}

export function _cancelBoardChatSelect() {
    _boardChatSelectMode = false;
    _boardChatSelectedIds.clear();
    const btn = document.querySelector('.board-select-btn');
    if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-pressed', 'false'); }
    // Restore chat input
    const inputPane = document.getElementById('board-chat-input-pane');
    if (inputPane) inputPane.style.display = '';
    _updateBoardChatSelectBar();
    const msgsEl = document.getElementById('board-panel-msgs');
    if (msgsEl) _renderBoardPanelMessages(msgsEl, false);
}

function _updateBoardChatSelectBar() {
    const panel = document.getElementById('agentic-panel-board');
    if (!panel) return;
    let bar = document.getElementById('board-chat-select-bar');
    if (!_boardChatSelectMode) {
        if (bar) bar.style.display = 'none';
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'board-chat-select-bar';
        bar.className = 'mb-select-bar';
        panel.appendChild(bar);
    }
    const count = _boardChatSelectedIds.size;
    bar.innerHTML = `
        <span class="mb-select-count">${count} selected</span>
        <button class="btn btn-small" data-on-click="board-chat-select-all">Select All</button>
        <button class="btn btn-small" data-on-click="board-chat-select-none">None</button>
        <button class="btn btn-small btn-primary" data-on-click="board-chat-export" ${count === 0 ? 'disabled' : ''}>Export Markdown</button>
        <button class="btn btn-small" data-on-click="board-chat-select-cancel">Cancel</button>
    `;
    bar.style.display = '';
}

export async function _exportBoardChatSelected() {
    const selected = _boardChatMessages
        .filter(m => _boardChatSelectedIds.has(m.id))
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    if (!selected.length) return;

    const project = _activeBoardChat || 'board';
    const now = new Date().toLocaleString();
    let md = `# ${project} — Exported Chat\n\n`;
    md += `**Exported**: ${now} · **Messages**: ${selected.length}\n\n---\n\n`;
    for (const m of selected) {
        const agent = m.job_title || m.sender_name || 'Unknown';
        const time = _formatTime(m.created_at);
        md += `### ${agent} — ${time}\n${m.content}\n\n`;
    }
    md += `---\n*Exported from Coral*\n`;

    try {
        await navigator.clipboard.writeText(md);
        showToast(`Copied ${selected.length} messages to clipboard`);
    } catch { /* fallback to download only */ }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project}-selected-export.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    _cancelBoardChatSelect();
}

let _boardChatReplyTo = null; // { id, name }: the message the box's text answers (Reply), sent as reply_to while the text still starts with the name

/** The Table | Chat switch in the tab's head line (the choice is the team page's: one remembered setting). */
function mountDockTableSwitch(panel) {
    const head = panel.querySelector('.board-chat-header');
    if (!head || head.querySelector(':scope > .mb-table-tools')) return;
    mountTableTools(head, { view: boardView(), pills: false, onView: v => {
        saveBoardView(v);
        const box = document.getElementById('board-panel-msgs');
        const bottom = box && box.scrollTop >= box.scrollHeight - box.clientHeight - 20;
        if (box) { applyView(box, v); if (bottom) box.scrollTop = box.scrollHeight; }
    } });
    head.insertBefore(head.querySelector(':scope > .mb-table-tools'), head.querySelector('#board-chat-pause-btn'));
}

/** The search row under the scope row (or the head): the board's search bar in the dock. */
function _mountDockSearch(panel, boardName) {
    let host = panel.querySelector(':scope > .board-chat-search');
    if (!host) {
        host = document.createElement('div'); host.className = 'board-chat-search';
        (panel.querySelector(':scope > .board-chat-scope') || panel.querySelector('.board-chat-header')).after(host);
    }
    _dockSearch.mount(host, boardName, _dockSearchHooks);
}

/** The older pages the dock has not loaded yet, until the message asked for is in the list (or the board's start is). */
async function _dockLoadAllEarlier(untilId = null) {
    for (let i = 0; i < 400 && _boardChatOffset > 0 && (untilId === null || !_boardChatMessages.some(m => m.id === untilId)); i++) {
        const before = _boardChatMessages.length;
        await _loadEarlierBoardChat();
        if (_boardChatMessages.length === before && _boardChatOffset > 0) await new Promise(r => setTimeout(r, 50)); // sleep-ok: a page already loading: wait for it
    }
}

/** A match of the dock's search: its page is loaded, the row scrolled to the middle, the matches marked. */
async function _dockJumpTo(id) {
    await _dockLoadAllEarlier(id);
    const box = document.getElementById('board-panel-msgs');
    if (!box) return;
    const row = box.querySelector(`:scope > .mb-message[data-message-id="${CSS.escape(String(id))}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
    _dockSearch.highlight(box);
}

/** The scope row under the dock's head: one quiet line saying what the agent's list is. Not drawn for the Orchestrator or an agent with no member id. */
function _syncScopeBar(panel) {
    let bar = panel.querySelector(':scope > .board-chat-scope');
    if (!_boardChatReader) { bar?.remove(); return; }
    if (!bar) {
        bar = document.createElement('div'); bar.className = 'board-chat-scope';
        const note = document.createElement('p'); note.className = 'board-chat-scope-note'; note.id = 'board-chat-scope-note';
        bar.append(note);
        panel.querySelector('.board-chat-header').after(bar);
    }
    _syncScopeNote();
}

/** "Showing what Ada reads: its mentions, @all, its replies and its own posts. 12 of 184 messages": whenever the dock is an agent's. */
function _syncScopeNote() {
    const note = document.getElementById('board-chat-scope-note');
    if (!note) return;
    const text = _boardChatScope && _boardChatReader
        ? `Showing what ${_boardChatReader.name} reads: its mentions, @all, its replies and its own posts.${_boardChatLoaded && _boardChatBoardTotal ? ` ${_boardChatTotal}\u00a0of\u00a0${_boardChatBoardTotal}\u00a0messages` : ''}`
        : '';
    if (note.textContent !== text) note.textContent = text;
    note.hidden = !text;
}

/** Reply in the dock: "@Sender " at the start of the box's text and the focus in it. */
function _boardChatReply(id, name) {
    const input = document.getElementById('board-panel-input');
    if (!input) return;
    const prefix = `@${name} `;
    if (!input.value.toLowerCase().startsWith(prefix.toLowerCase())) input.value = prefix + input.value;
    _boardChatReplyTo = { id: Number(id), name };
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

/** Copy link in the dock: the message's own address (the team page's Board tab with the message's number). */
async function _boardChatCopyLink(id) {
    if (!_activeBoardChat) return;
    try { await navigator.clipboard.writeText(`${location.origin}${build(keyRoute('team', _activeBoardChat, 'messages', Number(id)))}`); showToast('Link copied'); } catch { showToast('Could not copy the link', true); }
}

onRowActions('.board-chat-messages', { reply: _boardChatReply, link: _boardChatCopyLink, task: id => openTask(_activeBoardChat, id) });

async function _sendBoardChat(boardName) {
    const inputEl = document.getElementById('board-panel-input');
    if (!inputEl) return;
    const content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = '';
    let sent = false, unknown = '';
    try {
        const resp = await boardFetch(boardName, `/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriber_id: OPERATOR_ID, as: 'Operator', content, ...(_boardChatReplyTo && content.toLowerCase().startsWith(`@${_boardChatReplyTo.name.toLowerCase()}`) ? { reply_to: _boardChatReplyTo.id } : {}) }),
        });
        sent = resp.ok;
        if (!sent) unknown = await outcomeUnknownLine(resp); // the hub lost the answer: it may have reached the computer
    } catch { /* not sent: said below */ }
    if (!sent) {
        // The words go back in the box (ahead of anything typed since) and the failure is said: a message that vanished with no word is the worst way to fail (#6275).
        inputEl.value = inputEl.value ? `${content}\n${inputEl.value}` : content;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        showToast(unknown || 'Could not send to the team. Your message is back in the box.', true); // the words are back in the box either way; nothing is sent again by itself
        return;
    }
    _boardChatReplyTo = null;
    announceNotice('Message sent'); // heard once, not drawn: the message itself appears in the list
    _loadBoardPanelChat(boardName);
}
(window.__coral ||= {})._sendBoardChat = _sendBoardChat;

export async function _toggleBoardChatPause(boardName) {
    const btn = document.getElementById('board-chat-pause-btn');
    const banner = document.getElementById('board-chat-paused-banner');
    const wasPaused = btn?.classList.contains('mb-action-danger');
    const endpoint = wasPaused ? 'resume' : 'pause';
    try {
        await boardFetch(boardName, `/${endpoint}`, { method: 'POST' });
        _paintPauseButton(btn, !wasPaused);
        if (banner) {
            banner.style.display = wasPaused ? 'none' : '';
        }
    } catch { /* ignore */ }
}

async function _checkBoardPauseState(boardName) {
    try {
        const resp = await boardFetch(boardName, `/paused`);
        const data = await resp.json();
        const btn = document.getElementById('board-chat-pause-btn');
        const banner = document.getElementById('board-chat-paused-banner');
        _paintPauseButton(btn, !!data.paused);
        if (banner) {
            banner.style.display = data.paused ? '' : 'none';
        }
    } catch { /* ignore */ }
}

// Board chat @mention autocomplete
let _boardSubscribers = {};
let _mentionBoard = '';
/** The board's member names for @mention highlighting, once per board: fetched (or taken from the @ picker's cache), then the bodies on screen are marked in place if the names changed. */
async function _syncMentionNames(boardName) {
    if (_mentionBoard === boardName) return;
    _mentionBoard = boardName;
    try {
        if (!_boardSubscribers[boardName]) { const r = await boardFetch(boardName, `/subscribers`); if (!r.ok) { _mentionBoard = ''; return; } _boardSubscribers[boardName] = await r.json(); }
    } catch { _mentionBoard = ''; return; }
    if (_activeBoardChat !== boardName) return;
    const subs = Array.isArray(_boardSubscribers[boardName]) ? _boardSubscribers[boardName] : [];
    if (setBoardMentionNames(subs.flatMap(s => [s.job_title, s.subscriber_id]))) { highlightMentionsIn(document.getElementById('board-panel-msgs')); retagMentions(document.getElementById('board-panel-msgs')); } // in place: nothing is redrawn
    const empty = document.querySelector('#board-panel-msgs > .empty-state.empty-state-tight'); // an empty board names its lead once the members are known
    if (empty && empty.textContent !== _emptyBoardLine()) empty.textContent = _emptyBoardLine();
}
export async function _boardMentionInput(event, boardName) {
    const input = event.target;
    const text = input.value;
    const cursor = input.selectionStart;
    const beforeCursor = text.slice(0, cursor);
    const dropdown = document.getElementById('board-mention-dropdown');
    if (!dropdown) return;

    // Find @ trigger
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (!atMatch) { _closeBoardMentions(); return; }
    const query = atMatch[1].toLowerCase();

    // Fetch subscribers if not cached
    if (!_boardSubscribers[boardName]) {
        try {
            const resp = await boardFetch(boardName, `/subscribers`);
            _boardSubscribers[boardName] = await resp.json();
        } catch { _boardSubscribers[boardName] = []; }
    }

    const subs = (_boardSubscribers[boardName] || [])
        .map(s => s.job_title || s.session_id || 'unknown')
        .filter(name => name.toLowerCase().includes(query));

    if (subs.length === 0) { _closeBoardMentions(); return; }

    dropdown.innerHTML = subs.map((name, i) =>
        `<div class="board-mention-item" id="board-mention-opt-${Number(i)}" role="option" aria-selected="false" data-on-mousedown="board-mention-pick" data-name="${escapeAttr(name)}">${escapeHtml(name)}</div>`
    ).join('');
    const first = dropdown.querySelector('.board-mention-item');
    first.classList.add('active');
    first.setAttribute('aria-selected', 'true');
    dropdown.style.display = 'block';
    _syncBoardMentions();
}

function _closeBoardMentions() {
    const dropdown = document.getElementById('board-mention-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    _syncBoardMentions();
}

/** The combobox attributes follow the list: expanded while it shows, and the highlighted option is the active descendant. */
function _syncBoardMentions() {
    const input = document.getElementById('board-panel-input');
    const dropdown = document.getElementById('board-mention-dropdown');
    if (!input || !dropdown) return;
    const open = dropdown.style.display !== 'none';
    input.setAttribute('aria-expanded', String(open));
    const active = open && dropdown.querySelector('.board-mention-item.active');
    if (active) input.setAttribute('aria-activedescendant', active.id); else input.removeAttribute('aria-activedescendant');
}

/** Arrow keys move through the @mention list, Enter or Tab picks the highlighted name, Escape closes it. True when the key was used. */
export function _boardMentionKey(event) {
    const dropdown = document.getElementById('board-mention-dropdown');
    if (!dropdown || dropdown.style.display === 'none') return false;
    const items = [...dropdown.querySelectorAll('.board-mention-item')];
    if (!items.length) return false;
    const at = Math.max(0, items.findIndex(i => i.classList.contains('active')));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const next = menuMove(event.key, items.length, at);
        items.forEach((it, i) => { it.classList.toggle('active', i === next); it.setAttribute('aria-selected', String(i === next)); });
        items[next].scrollIntoView?.({ block: 'nearest' });
        _syncBoardMentions();
    } else if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
        _insertBoardMention(items[at].dataset.name);
    } else if (event.key === 'Escape') {
        _closeBoardMentions();
    } else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
}

export function _insertBoardMention(name) {
    const input = document.getElementById('board-panel-input');
    if (!input) return;
    const text = input.value;
    const cursor = input.selectionStart;
    const beforeCursor = text.slice(0, cursor);
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx === -1) return;
    const after = text.slice(cursor);
    input.value = beforeCursor.slice(0, atIdx) + '@' + name + ' ' + after;
    input.selectionStart = input.selectionEnd = atIdx + name.length + 2;
    input.focus();
    _closeBoardMentions();
}
