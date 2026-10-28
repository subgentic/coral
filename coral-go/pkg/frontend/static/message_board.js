import { fetchAllBoardMessages, fetchAllHistory, fetchAllLiveChat, fetchProjects } from './board_fetch.js';
import { doExportBoard, toggleMessageSelect, selectAllMessages, selectNoneMessages, cancelSelectMode, exportSelectedAsMarkdown, resetSelection, connectBoard, hideExportBoardModal } from './board_export.js';
import { emptyState } from './dom_write.js';
import { escapeAttr, escapeHtml, showView, OPERATOR_ID, showToast } from './utils.js';
import { keyLabel, splitKey, hasBoardLabel, boardFetch, noteBoardLabel, inTeam } from './server_base.js';
import { importOnce } from './import_once.js';
import { agentWords, deleteTeamWords } from './agent_words.js';
import { state } from './state.js';
import { initGrowingTextarea } from './growing_textarea.js';
import { mountBoardSearch, resetBoardSearch, highlightBoard } from './board_search.js';
import { applyView, setAllRows, forgetOpenRows, watchFold, boardView, mountTableTools, saveBoardView, onRowActions } from './board_table.js';
import { openTask } from './task_navigation.js';
import { launchBlockedReason } from './hub_access.js';
import { registerActions, textOf, withId } from './actions.js';
import { bs } from './board_state.js';
import { attachMentionList, loadBoardSubscribers, subscribeDashboard } from './board_members.js';
import { confirmDeleteBoardMessage, copyMessageLink, loadPausedState, loadSleepState } from './board_controls.js';
import { clearNewPill, jumpToLatest } from './board_new_pill.js';
import { focusMessageById, formatTime, isAtBottom, jumpToFirst, loadBoardMessages, loadEarlierMessages, openMessageActions, renderMessages } from './board_window.js';
import { _pollNewMessages, startBoardPoll, stopBoardPoll } from './board_poll.js';
import { replyToMessage } from './board_composer.js';
import './goals_adapter.js'; // the Goals view (goals_view.js) is lazy and imports only what loads at startup (import_hygiene): its two small helpers load here (#7113)
import './goal_words.js';
export { fetchAllBoardMessages, fetchAllHistory, fetchAllLiveChat } from './board_fetch.js';
export { showExportBoardModal, doExportBoard, toggleSelectMode, toggleMessageSelect, selectAllMessages, selectNoneMessages, cancelSelectMode, exportSelectedAsMarkdown } from './board_export.js';
// the moved exports, still importable from here
export { postBoardMessage } from './board_composer.js';
export { toggleBoardPause } from './board_controls.js';
/* Message Board: project list, messages, subscribers, posting */

// ── Sidebar rendering ────────────────────────────────────────────────────

async function loadBoardProjects() {
    try {
        const projects = await fetchProjects();
        renderBoardSidebar(projects);
        const badge = document.getElementById('messageboard-count');
        if (badge) badge.textContent = String(projects.length);
    } catch (e) {
        console.error('Failed to load board projects:', e);
    }
}

function renderBoardSidebar(projects) {
    const list = document.getElementById('messageboard-sidebar-list');
    if (!list) return;
    if (!projects.length) {
        emptyState(list, 'No projects', 'empty-state empty-state-tight', 'li');
        return;
    }
    list.innerHTML = projects.map(p => {
        const active = bs.currentProject === p.project ? 'active' : '';
        return `<li class="session-list-item ${escapeAttr(active)}" data-on-click="mb-project" data-project="${escapeAttr(p.project)}"><button type="button" class="row-btn"${active ? ' aria-current="true"' : ''}>
            <span class="session-name">${escapeHtml(keyLabel(p.project))}</span>
            <span class="mb-project-count">${p.message_count} msgs</span>
        </button></li>`;
    }).join('');
}

// ── View switching ───────────────────────────────────────────────────────

/** A board's page is its team page's Messages tab (#8061): every link to a board (a chat, a message, a saved message, a list's row) opens it there, at /team/<team>/messages, and a message anchors where it is. */
export function selectBoardProject(project, messageId = null) {
    if (!project) return;
    window.switchNavTab?.('agents', { fromHistory: true }); // the team page lives under Agents; it writes its own address
    importOnce('./team_page.js').then(m => m.openTeamPage(project, { tab: 'messages', item: messageId != null ? Number(messageId) : 0 }));
}

/** The team page's Messages tab (#7453): the board's own column (#mb-board: the search bar, the messages, the composer) moved into `host`, and the board loaded and polled as on the board page. leaveBoardPage puts the column back and stops the poll. */
let _boardHome = null;
export function showBoardInPage(project, host, messageId = null) {
    const board = document.getElementById('mb-board');
    if (!board || !host) return;
    if (board.parentElement !== host) { _boardHome = { parent: board.parentElement, next: board.nextSibling }; host.append(board); }
    const again = bs.currentProject === project && bs._loadedProject === project;
    bs.currentProject = project;
    state.boardPageProject = project;
    state.currentBoardServer = splitKey(project).server;
    board.style.display = 'flex'; // display-ok: #mb-board is shown and hidden this way everywhere else in this file
    initGrowingTextarea(document.getElementById('mb-post-input'));
    attachMentionList();
    if (!hasBoardLabel(project)) {
        boardFetch(project, '').then(r => (r.ok ? r.json() : null)).then(d => {
            if (d && typeof d.board_label === 'string') noteBoardLabel(splitKey(project).server, splitKey(project).name, d.board_label);
        }).catch(() => {});
    }
    nameComposerForPage(true);
    mountBoardSearch(document.getElementById('mb-tools'), project, SEARCH_HOOKS);
    subscribeDashboard(project);
    loadPausedState(project);
    loadSleepState(project);
    syncBoardDeleteButton(project);
    applyBoardTable(project);
    if (!again) { clearNewPill(); bs.pendingMessageId = messageId != null ? String(messageId) : null; loadBoardMessages(project); }
    else if (messageId != null) focusMessageById(messageId); // a link to a message of the board already on screen
    loadBoardSubscribers(project);
    startBoardPoll();
}

/** On the team page the composer is "Message the team" and its button "Send" (UI/UX's design); they are put back when the column goes home (the hidden holder in the board view). */
function nameComposerForPage(on) {
    const box = document.getElementById('mb-post-input'), send = document.querySelector('#mb-board .mb-post-send-btn');
    for (const [e, name] of [[box, 'Message the team'], [send, 'Send']]) {
        if (!e) continue;
        if (on) { if (e.dataset.boardLabel === undefined) e.dataset.boardLabel = e.getAttribute('aria-label') || ''; e.setAttribute('aria-label', name); }
        else if (e.dataset.boardLabel !== undefined) { e.setAttribute('aria-label', e.dataset.boardLabel); delete e.dataset.boardLabel; }
    }
}

export function leaveBoardPage() {
    const board = document.getElementById('mb-board');
    if (!board || !_boardHome) return;
    nameComposerForPage(false);
    applyView(document.getElementById('mb-messages'), 'chat'); // the board's own page is the chat
    document.querySelector('#mb-tools > .mb-table-tools')?.remove();
    stopBoardPoll();
    bs.currentProject = null;
    board.style.display = 'none'; // display-ok: as above
    if (_boardHome.parent && _boardHome.parent.isConnected) _boardHome.parent.insertBefore(board, _boardHome.next && _boardHome.next.parentElement === _boardHome.parent ? _boardHome.next : null);
    _boardHome = null;
}

export function showMessageBoardProjects() {
    document.getElementById('messageboard-title').textContent = 'Message Board';
    resetBoardSearch();
    bs.currentProject = null;
    state.boardPageProject = null;
    clearNewPill();
    stopBoardPoll();
    // Exit select mode if active
    resetSelection();

    showView("messageboard-view");

    document.getElementById('mb-project-list').style.display = '';
    document.getElementById('mb-board').style.display = 'none';
    document.getElementById('mb-pause-btn').style.display = 'none';
    const sleepBtn2 = document.getElementById('mb-sleep-btn');
    if (sleepBtn2) sleepBtn2.style.display = 'none';
    document.getElementById('mb-delete-btn').style.display = 'none';
    document.getElementById('mb-select-btn').style.display = 'none';

    loadBoardProjectList();
    loadBoardProjects();
}

// ── Project list view ────────────────────────────────────────────────────

async function loadBoardProjectList() {
    const ul = document.getElementById('mb-projects-ul');
    const empty = document.getElementById('mb-projects-empty');
    // Show loading indicator while fetching
    empty.style.display = 'none';
    ul.innerHTML = '<li class="loading-indicator">Loading projects</li>';
    try {
        const projects = await fetchProjects();
        if (!projects.length) {
            ul.innerHTML = '';
            empty.style.display = '';
            return;
        }
        empty.style.display = 'none';
        ul.innerHTML = projects.map(p => `
            <li class="session-list-item" data-on-click="mb-project" data-project="${escapeAttr(p.project)}"
                style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px"><button type="button" class="row-btn">
                <div>
                    <strong>${escapeHtml(keyLabel(p.project))}</strong>
                    <div class="mb-project-meta">${p.server ? escapeHtml((state.servers || []).find(s => s.id === p.server)?.label || p.server) + ' · ' : ''}${p.subscriber_count} subscriber${p.subscriber_count !== 1 ? 's' : ''}</div>
                </div>
                <span class="mb-project-meta">${p.message_count} messages</span>
            </button></li>
        `).join('');
    } catch (e) {
        console.error('Failed to load board project list:', e);
    }
}

// ── Messages ─────────────────────────────────────────────────────────────

/** Tests: how many messages are loaded, how many the board has, and how many are not loaded yet. */
(window.__coral ||= {}).boardCounts = () => ({ shown: bs._allMessages.length, total: bs._totalMessages, notLoaded: bs._loadedOffset });
(window.__coral ||= {}).loadEarlierMessages = loadEarlierMessages;

const SEARCH_HOOKS = { me: OPERATOR_ID, redraw: () => highlightBoard(document.getElementById('mb-messages')), jumpTo: id => focusMessageById(id), first: () => jumpToFirst(), latest: () => jumpToLatest(), expandAll: () => setAllRows(document.getElementById('mb-messages'), true), collapseAll: () => setAllRows(document.getElementById('mb-messages'), false) };

// ── The board as a table (#7921) ─────────────────────────────────────────
let _pill = 'all'; // All, Questions or Mentions me: which rows the table shows
let _tableTeam = null;

/** The table's controls and view on the board's box: the pills and the Table | Chat switch under the search, the open rows dropped when the team changes. */
function applyBoardTable(project) {
    const box = document.getElementById('mb-messages'), host = document.getElementById('mb-tools');
    if (!box || !host) return;
    if (_tableTeam !== project) {
        _tableTeam = project; _pill = 'all'; bs._replyTo = null;
        forgetOpenRows();
        host.querySelector(':scope > .mb-table-tools')?.remove();
    }
    box.setAttribute('data-pill', _pill);
    watchFold(box);
    applyView(box, boardView());
    mountTableTools(host, {
        view: boardView(), pill: _pill,
        onView: v => { const bottom = isAtBottom(box); saveBoardView(v); applyView(box, v); if (bottom) box.scrollTop = box.scrollHeight; },
        onPill: p => { _pill = p; box.setAttribute('data-pill', p); },
    });
}

onRowActions('.mb-messages-scroll', { reply: replyToMessage, link: copyMessageLink, task: (id, el) => openTask(bs.currentProject, id, el) });

// ── Delete project ───────────────────────────────────────────────────────

// Through the Coral Hub, deleting a board needs Launch on its machine (#3433): below that the
// button is shown disabled with the reason (#3443), and redrawn once the access list is in.
function syncBoardDeleteButton(project) {
    const btn = document.getElementById('mb-delete-btn');
    if (!btn || !project) return;
    const blocked = launchBlockedReason(splitKey(project).server);
    btn.disabled = !!blocked;
    btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    btn.title = blocked || '';
    btn.textContent = blocked ? 'Delete (needs Launch)' : 'Delete';
}
document.addEventListener('coral:server-access-loaded', () => syncBoardDeleteButton(bs.currentProject));

/** The agents running on this board now, by name (the live list: not asleep, not archived). */
function runningAgentsOn(project) {
    return (state.liveSessions || []).filter(a => inTeam(a, project) && !a.sleeping && !a.archived).map(a => agentWords(a, a.display_name || a.name).role);
}

export function deleteMessageBoardProject() { deleteTeam(bs.currentProject); }

/** Delete team: the in-page dialog (which agents still run, or the words that say what goes), then the DELETE. From the team page's More menu and from the sidebar's team menu (#10318). */
export function deleteTeam(project) {
    const blocked = project ? launchBlockedReason(splitKey(project).server) : '';
    if (blocked) { showToast(blocked, true); return; }
    if (!project) return;
    // A board with agents running is not deleted (#5043): they would stay live in a group named with the raw board id. Said here, before asking; the server
    // says it again for an agent this page's list does not show yet.
    const running = runningAgentsOn(project);
    if (running.length) { // a real dialog, not a toast that is gone before it is read (#10139): which agents, and the way out; the server says it again for one this list does not show yet
        window.showConfirmModal('Delete team', deleteTeamWords(keyLabel(project), running), () => { window.openTeamPage?.(project); }, undefined, { label: 'Show its agents', cancelLabel: 'Close', danger: false });
        return;
    }
    window.showConfirmModal('Delete team', deleteTeamWords(keyLabel(project)), async () => {
        try {
            const resp = await boardFetch(project, ``, { method: 'DELETE' });
            if (!resp.ok) {
                const out = await resp.json().catch(() => ({}));
                showToast(out.error || 'The board was not deleted.', true);
                return;
            }
            if (document.getElementById('team-page-view')?.getClientRects().length) { window.exitTeamPage?.({ force: true }); window.switchNavTab?.('agents'); } // deleted from its team page: back to Agents, not the board list
            else if (document.getElementById('messageboard-view')?.getClientRects().length) showMessageBoardProjects();
            // deleted from the sidebar's team menu: the page stays where it is; the live feed takes the group away
        } catch (e) {
            console.error('Failed to delete project:', e);
            showToast('Could not reach Coral to delete the board.', true);
        }
    }, undefined, { label: 'Delete team', danger: true });
}

// ── Polling ──────────────────────────────────────────────────────────────

(window.__coral ||= {}).pollBoardNow = _pollNewMessages; // tests: a poll without waiting 10 s

// ── Init ─────────────────────────────────────────────────────────────────

// What the export and select code needs of the open board (board_export.js).
connectBoard({ project: () => bs.currentProject, messages: () => bs._allMessages, render: () => renderMessages(bs._allMessages), formatTime });

export function initMessageBoard() {
    loadBoardProjects();
}

export { loadBoardProjects };

// The board's generated markup (#3645): data-on-* names, never code. Ids and names are checked
// before use; a bad one does nothing. Deleting a message never asked first, and still doesn't.
registerActions({
    'mb-project': el => { const p = textOf(el.dataset.project); if (p) selectBoardProject(p); },
    'mb-jump-latest': () => jumpToLatest(),
    'mb-msg-select': el => withId(el.dataset.msgId, id => toggleMessageSelect(id, el.checked)),
    'mb-msg-delete': el => withId(el.dataset.msgId, confirmDeleteBoardMessage),
    'mb-msg-more': el => openMessageActions(el),
    'mb-export-agents': el => document.querySelectorAll('.export-agent-cb').forEach(c => { c.checked = el.dataset.checked === '1'; }),
    'mb-export-do': () => doExportBoard(),
    'mb-export-close': () => hideExportBoardModal(),
    'mb-select-all': () => selectAllMessages(),
    'mb-select-none': () => selectNoneMessages(),
    'mb-export-selected': () => exportSelectedAsMarkdown(),
    'mb-select-cancel': () => cancelSelectMode(),
});
