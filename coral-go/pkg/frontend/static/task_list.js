/* The task list: polling, loading, filtering, sorting and drawing it (moved out of tasks.js, #5082; no behaviour change). */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { pollEvery, afterPause, isBusyStatus, busyRetryingText, machineOf } from './overload.js';
import { platform } from './platform/detect.js';
import { loadSubagents, _claimedFor, _subagentTooltip, subagentToTaskRow } from './subagents.js';
import { _currentBoardKey, agentTaskScope } from './task_board_context.js';
import { pathId, boardFetch, serverFetch, serverForSession, fetchValidated, dropBody, isCloud, serverUrl, splitKey } from './server_base.js';
import { EMPTY as TASK_EMPTY, SORT_LABEL as taskSortLabel, isQuery, loadFilters as loadTaskFilters, phases as taskPhases, toParams as taskParams, saveFilters as saveTaskFilters } from './task_filters.js';
import { browserLocal } from './safe_storage.js';
import { showToast, escapeHtml } from './utils.js';
import { loadPanelOpen, savePanelOpen } from './list_bar.js';
import { _agentTaskStatus } from './task_format.js';
import { reviewRequested, taskStatus, defaultSort, nextSort, filterAndSortTasks } from './task_list_data.js';
import { morphHtml } from './dom_morph.js';
import { goalTitle, refreshGoalTitles } from './task_goals.js';
import * as DT from './data_table.js';
import * as TV from './tasks_view.js';
import { taskStatusWord, statusClass } from './goal_words.js';
import { whenText } from './when_text.js';

const dockTaskTableState = DT.tableState();
/** The state as it is said: the word the chip shows, then the richer detail when there is one ("In progress (Claimed · Working)"): what is seen is what is heard (#8830). The task number is the row's hover title, not in its name. */
const spoken = (word, st) => { const d = st.detail || ''; return d.toLowerCase().startsWith(word.toLowerCase()) ? d : /·/.test(d) ? `${word} (${d})` : word; }; // "Blocked: waiting for prerequisites" already starts with its word
let previewTask = null;
export async function openDockTaskPreview(id, opener) {
    const project = _currentBoardKey(), session = state.currentSession;
    if (!project) return;
    const pane = await importOnce('./preview_pane.js');
    if (state.currentSession !== session || _currentBoardKey() !== project) return;
    const key = `board:${id}`;
    const selection = { project, key };
    previewTask = selection;
    const mark = () => { for (const row of document.querySelectorAll('#board-task-list tbody tr')) { if (previewTask?.project === project && row.dataset.key === previewTask?.key) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current'); } };
    const row = () => { const tr = opener && opener.isConnected ? opener.closest('tr') : [...document.querySelectorAll('#board-task-list tbody tr')].find(r => r.dataset.key === key); return tr?.querySelector('.dt-primary') || null; }; // the row's one button: what had the focus (the click's target may be the row itself, which is not focusable)
    pane.openTaskPreview(project, id, opener?.closest('tr')?.querySelector('.dt-primary')?.textContent || `Task ${id}`, ({ keyboard } = {}) => {
        if (previewTask === selection) { previewTask = null; mark(); }
        if (keyboard) queueMicrotask(() => row()?.focus({ preventScroll: true })); // a keyboard close gives the focus back to the row that opened it, at every width (#8830), after the pane has been redrawn and hidden; after a mouse click the row would wear a ring
    });
    mark();
}


let _goalBoard = ''; // the board whose goal titles the chips read (the one the list was last loaded for)

// ── Board task polling ───────────────────────────────────────────────
export let _boardTaskPollTimer = null;

// Seam for tests: the poll period, read when the poll starts (tests shorten it instead of waiting 10 s per tick).
export const boardTaskPollHooks = { intervalMs: 10000 };

// The tick in flight, if any. A large board's task list can take longer than the period to
// fetch and draw; a tick never starts while the previous one runs, so slow fetches cannot
// pile up behind each other (#3262).
let _boardTaskPollInFlight = null;

// Live cost cache: taskID → { cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, request_count }
export let _liveCosts = {};

export function startBoardTaskPoll() {
    stopBoardTaskPoll();
    // Load agent tasks + board tasks immediately, then poll board tasks every 10s
    if (!state.selectedTeam && state.currentSession && state.currentSession.type === 'live') {
        loadAgentTasks(state.currentSession.name, state.currentSession.session_id);
    }
    // Subagents are loaded by the poll below, every tick: their status and
    // spend keep changing while they run, with no user action to trigger a reload.
    _boardTaskPollTick(true);
    _boardTaskPollTimer = pollEvery(_boardTaskPollTick, boardTaskPollHooks.intervalMs, { whenHidden: true }); // its own guard decides (#3200)
}

/** One poll tick: skipped while the previous tick runs, and while the tab is hidden (a hidden
 *  tab catches up when shown). Native webviews can report hidden permanently, so they always poll. */
export function _boardTaskPollTick(force = false) {
    // force: a (re)start for a new selection loads at once, even past the old selection's tick.
    if (!force && (_boardTaskPollInFlight || (!platform.isNative && document.hidden))) return;
    const run = _pollBoardTasksOnce().catch(() => {}).finally(() => {
        if (_boardTaskPollInFlight === run) _boardTaskPollInFlight = null;
    });
    _boardTaskPollInFlight = run;
}

export function stopBoardTaskPoll() {
    if (_boardTaskPollTimer) {
        clearInterval(_boardTaskPollTimer);
        _boardTaskPollTimer = null;
    }
}

async function _pollBoardTasksOnce() {
    // A selected team shows that team's board tasks, even with no agent selected.
    if (state.selectedTeam) {
        await loadBoardTasks(state.selectedTeam);
        await _fetchLiveCosts(state.selectedTeam);
        return;
    }
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    loadSubagents(state.currentSession.name, state.currentSession.session_id);
    const boardProject = _currentBoardKey();
    if (boardProject) {
        await loadBoardTasks(boardProject);
        await _fetchLiveCosts(boardProject);
    }
}

async function _fetchLiveCosts(boardProject) {
    const tasks = agentTaskScope() ? _filteredList.rows : state.currentBoardTasks || [];
    const inProgress = tasks.filter(t => t.status === 'in_progress' && t.session_id);
    if (inProgress.length === 0) {
        _liveCosts = {};
        return;
    }
    const newCosts = {};
    await Promise.all(inProgress.map(async (t) => {
        try {
            const resp = await boardFetch(boardProject, `/tasks/${pathId(t.id)}/cost`);
            if (resp.ok) {
                const data = await resp.json();
                if (data) newCosts[t.id] = data;
            }
        } catch { /* ignore */ }
    }));
    _liveCosts = newCosts;
    renderBoardTaskList();
}

export async function loadAgentTasks(agentName, sessionId, options) {
    if (!agentName) return;
    const sid = sessionId || (state.currentSession && state.currentSession.session_id);
    try {
        const params = new URLSearchParams();
        if (sid) params.set("session_id", sid);
        const qs = params.toString() ? `?${params}` : "";
        const resp = await serverFetch(serverForSession(agentName, sid), `/api/sessions/live/${encodeURIComponent(agentName)}/tasks${qs}`, options);
        if (!resp.ok) throw new Error(`tasks fetch failed: ${resp.status}`);
        const tasks = await resp.json();
        if (sid && state.currentSession?.session_id !== sid) return;
        state.currentAgentTasks = tasks;
    } catch (e) {
        if (e?.name === 'AbortError') return;
        if (sid && state.currentSession?.session_id !== sid) return;
        state.currentAgentTasks = [];
    }
    renderTaskList();
}

export function renderTaskList() {
    // Agent tasks are now rendered in the unified board task table.
    // Trigger a re-render of the unified table to include updated agent tasks.
    renderBoardTaskList();
}

// The latest loadBoardTasks call wins: a slow answer for a board the user has left (or an
// older answer for the same board) never replaces a newer one (#3262).
let _boardTasksLoadSeq = 0;

// The task list is paged (#3269): a load gets every open task and the newest done tasks,
// as light items (no body or workflow text; the detail view fetches the full task).
// "Load more" pages older done tasks with the cursor; a poll refreshes the first page
// and keeps the older pages already loaded.
 const BOARD_TASK_PAGE = 50;
const _fetchTaskPage = (board, cursor) => _boardTasksFetch(board, `/tasks?limit=${BOARD_TASK_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); // one page of the default list: the open tasks, then the done ones (#9121)

// A fetch that never answers (a hung server, a dead hub link) must not stop the poll for
// good, since the poll never starts a tick while one runs (#3262).
export const boardTaskFetchHooks = { timeoutMs: 20000 };

const _emptyBoardList = board => ({ board, first: [], older: [], pages: 0, nextCursor: '', totalOpen: null, totalCompleted: null });

let _boardList = _emptyBoardList(null);

async function _boardTasksFetch(boardName, suffix) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), boardTaskFetchHooks.timeoutMs);
    try {
        // Polled every 10 s per open board: an unchanged page comes back 304 (#3439).
        const r = await fetchValidated('board-tasks ' + boardName + suffix, headers => boardFetch(boardName, suffix, { signal: ctrl.signal, headers }));
        if (!r.ok) { dropBody(r.resp); const err = new Error(`board tasks fetch failed: ${r.resp.status}`); err.resp = r.resp; throw err; }
        return JSON.parse(r.text);
    } finally {
        clearTimeout(timer);
    }
}

/** The list: the first page, then the older done tasks loaded with "Load more". */
function _setBoardTasks() {
    const first = new Set(_boardList.first.map(t => t.id));
    _boardList.older = _boardList.older.filter(t => !first.has(t.id) && (t.status === 'completed' || t.status === 'skipped'));
    state.currentBoardTasks = [..._boardList.first, ..._boardList.older];
}

export async function loadBoardTasks(boardName) {
    _syncTaskFiltersBoard(boardName);
    _goalBoard = boardName || '';
    await _loadBoardTasksDefault(boardName);
    // The goal chips name their goals once the titles are read (#7253): a board whose tasks serve no goal reads none (select_session_trace pins a board's requests; #7346).
    if (boardName && (state.currentBoardTasks || []).some(t => t && t.goal_id)) refreshGoalTitles(boardName).then(changed => { if (changed) renderBoardTaskList(); }, () => {});
    if (_queryActive()) await _loadFilteredTasks(boardName, { refresh: true });
}

async function _loadBoardTasksDefault(boardName) {
    const seq = ++_boardTasksLoadSeq;
    if (!boardName) {
        _boardList = _emptyBoardList(null);
        state.currentBoardTasks = [];
        renderBoardTaskList();
        return;
    }
    let data = null, refused = null;
    try {
        const scope = agentTaskScope();
        if (scope) {
            if (!scope.assignee) data = { tasks: [], total_open: 0, total_completed: 0 };
            else {
                const f = { ...TASK_EMPTY, assignee: scope.assignee };
                const phases = taskPhases(f);
                const [open, done] = await Promise.all(phases.map(statuses => _taskQueryFetch(boardName, taskParams(f, boardName, { statuses, limit: 1 }))));
                data = { tasks: [], total_open: open.total ?? 0, total_completed: done.total ?? 0 };
            }
        } else data = await _fetchTaskPage(boardName, '');
    } catch (e) {
        data = null;
        if (e && e.resp && isBusyStatus(e.resp.status)) refused = e.resp;
    }
    if (seq !== _boardTasksLoadSeq || _taskScopeKey !== (agentTaskScope()?.key || '')) return;
    const sameBoard = _boardList.board === boardName;
    if (!data) {
        // A failed refresh keeps the board's last good list; another board's is dropped.
        if (sameBoard && !_boardList.busy) return;
        _boardList = _emptyBoardList(boardName);
        state.currentBoardTasks = [];
        // A first load refused as busy (#3430): say so instead of "No tasks yet", and load again
        // once the pause is over rather than at the next 10 s poll; a newer load supersedes it.
        if (refused) {
            _boardList.busy = busyRetryingText(refused, { hub: isCloud() });
            let machine = '';
            try { machine = machineOf(new URL(refused.url).pathname); } catch { /* same server */ }
            afterPause(() => {
                // Only for the board still shown, and only if no newer load has started.
                if (seq === _boardTasksLoadSeq && (state.selectedTeam || _currentBoardKey()) === boardName) loadBoardTasks(boardName);
            }, machine);
        }
        renderBoardTaskList();
        return;
    }
    // Once "Load more" was used, the pages the person loaded are read again with the first (#9121): the default list pages the open tasks too, so an older page can hold an open task that has finished
    // since, and a task finished since pushes the oldest done ones off page one; the cursor of the last page read continues from there.
    const depth = sameBoard ? _boardList.pages : 0;
    let older = [], nextCursor = data.next_cursor || '';
    if (depth > 0 && nextCursor) {
        try {
            for (let i = 0; i < depth && nextCursor; i++) {
                const more = await _fetchTaskPage(boardName, nextCursor);
                older = older.concat(more.tasks || []);
                nextCursor = more.next_cursor || '';
            }
        } catch { older = sameBoard ? _boardList.older : []; nextCursor = sameBoard ? _boardList.nextCursor : nextCursor; } // a failed re-read keeps what the person had
        if (seq !== _boardTasksLoadSeq) return;
    }
    _boardList = {
        board: boardName,
        first: data.tasks || [],
        older,
        pages: depth,
        // Once older pages are loaded, "Load more" continues after the last of them.
        nextCursor,
        // A server from before pagination sends every task and no totals.
        scopeKey: agentTaskScope()?.key || '',
        totalOpen: data.total_open ?? null,
        totalCompleted: data.total_completed ?? null,
    };
    _setBoardTasks();
    renderBoardTaskList();
}

// ── Search and filters (#4744) ───────────────────────────────────────────
// With a search, a filter or an order the default list does not have, the board's tasks come from the task query (GET /api/board/tasks, the server matches every task of the board, #4745),
// as pages with a total. Without them nothing here runs and the list is the paged default above. "Open first" has no server sort: it is the open tasks, then the done ones (two phases).
const _emptyFiltered = board => ({ board, rows: [], phase: 0, cursor: '', total: null, doneTotal: 0, truncated: false, busy: false, error: '' });

let _filteredList = _emptyFiltered(null);

let _taskFilters = { ...TASK_EMPTY };

let _taskFiltersBoard = null;

let _taskBar = null;

let _filteredSeq = 0;

const _queryActive = () => (isQuery(_taskFilters) || !!agentTaskScope()) && !!_boardList.board;
const viewFilters = () => { const scope = agentTaskScope(); return scope ? { ..._taskFilters, assignee: scope.assignee } : _taskFilters; };
let _taskScopeKey = '';

/** A board change: its own saved filters, a fresh bar (the old one lets go of the page's click listener). */
function _syncTaskFiltersBoard(boardName) {
    const scopeKey = agentTaskScope()?.key || '';
    if (boardName === _taskFiltersBoard && scopeKey === _taskScopeKey) return;
    if (scopeKey !== _taskScopeKey) { _boardList = _emptyBoardList(boardName); state.currentBoardTasks = []; }
    _taskScopeKey = scopeKey;
    _taskFiltersBoard = boardName;
    _taskFilters = loadTaskFilters(scopeKey ? `${boardName}:${scopeKey}` : boardName, browserLocal);
    if (scopeKey) _taskFilters.assignee = '';
    _filteredList = _emptyFiltered(boardName);
    _filteredSeq++;
    if (_taskBar) { _taskBar.dispose(); _taskBar = null; }
}

async function _taskQueryFetch(boardKey, pairs) {
    const { server, name } = splitKey(boardKey);
    const qs = new URLSearchParams(pairs.map(([k, v]) => [k, k === 'board' ? name : v])).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), boardTaskFetchHooks.timeoutMs);
    try {
        const r = await fetch(serverUrl(`/api/board/tasks?${qs}`, server), { signal: ctrl.signal });
        if (!r.ok) { const err = new Error(`task search failed: ${r.status}`); err.resp = r; throw err; }
        return await r.json();
    } finally { clearTimeout(timer); }
}

/** Fetch the filtered list's first page (or the next one: `append`), from the phase and cursor it is at. A poll (`refresh`) keeps a list the person paged further. */
async function _loadFilteredTasks(boardName, { append = false, refresh = false } = {}) {
    const savedFilters = _taskFilters;
    const scopeKey = agentTaskScope()?.key || '';
    const f = viewFilters();
    if (scopeKey && !f.assignee) { _filteredList = { ..._emptyFiltered(boardName), total: 0 }; renderBoardTaskList(); return; }
    const ph = taskPhases(f);
    const L = _filteredList.board === boardName ? _filteredList : (_filteredList = _emptyFiltered(boardName));
    if (refresh && L.rows.length > BOARD_TASK_PAGE) return; // paged further than the first page: a poll leaves it
    const seq = ++_filteredSeq;
    L.busy = true; L.error = '';
    if (!refresh) renderBoardTaskList();
    try {
        let rows, cursor, total, doneTotal = L.doneTotal, truncated = false, phase = L.phase;
        if (append) {
            const statuses = ph ? ph[phase] : null;
            if (ph && phase === 0 && !L.cursor) phase = 1;
            const pairs = taskParams(f, boardName, { statuses: ph ? ph[phase] : null });
            if (phase === L.phase && L.cursor) pairs.push(['cursor', L.cursor]);
            const data = await _taskQueryFetch(boardName, pairs);
            if (seq !== _filteredSeq || _taskFilters !== savedFilters || scopeKey !== (agentTaskScope()?.key || '')) return;
            const seen = new Set(L.rows.map(t => t.id));
            rows = [...L.rows, ...(data.tasks || []).filter(t => !seen.has(t.id))];
            cursor = data.next_cursor || ''; total = L.total; truncated = L.truncated || !!data.truncated; void statuses;
        } else if (ph) {
            const [open, done] = await Promise.all([
                _taskQueryFetch(boardName, taskParams(f, boardName, { statuses: ph[0] })),
                _taskQueryFetch(boardName, taskParams(f, boardName, { statuses: ph[1], limit: agentTaskScope() && !isQuery(savedFilters) ? BOARD_TASK_PAGE : 1 })),
            ]);
            if (seq !== _filteredSeq || _taskFilters !== savedFilters || scopeKey !== (agentTaskScope()?.key || '')) return;
            rows = open.tasks || []; cursor = open.next_cursor || ''; phase = 0;
            if (scopeKey && !isQuery(savedFilters) && !cursor) { rows = [...rows, ...(done.tasks || [])]; cursor = done.next_cursor || ''; phase = 1; }
            doneTotal = done.total ?? 0; total = (open.total ?? rows.length) + doneTotal; truncated = !!(open.truncated || done.truncated);
        } else {
            const data = await _taskQueryFetch(boardName, taskParams(f, boardName));
            if (seq !== _filteredSeq || _taskFilters !== savedFilters || scopeKey !== (agentTaskScope()?.key || '')) return;
            rows = data.tasks || []; cursor = data.next_cursor || ''; total = data.total ?? rows.length; truncated = !!data.truncated; phase = 0;
        }
        Object.assign(L, { rows, cursor, total, doneTotal, truncated, phase });
    } catch (e) {
        if (seq !== _filteredSeq || _taskFilters !== savedFilters || scopeKey !== (agentTaskScope()?.key || '')) return;
        L.error = e && e.resp && e.resp.status === 400 ? 'This search can not be run. Change it and try again.' : 'Could not search the tasks. Try again.';
        if (append) showToast(L.error, true);
    } finally {
        if (seq === _filteredSeq) { L.busy = false; renderBoardTaskList(); }
    }
}

/** Is there another page of the filtered list (the open phase ending hands over to the done phase). */
function _filteredHasMore() {
    const L = _filteredList;
    if (L.cursor) return true;
    return !!taskPhases(viewFilters()) && L.phase === 0 && L.doneTotal > 0;
}

/** The bar's choice: kept for the board, and the list is asked again (or the default list is back). */
function _setTaskFilters(next) {
    if (agentTaskScope()) next = { ...next, assignee: '' };
    _taskFilters = next;
    saveTaskFilters(_taskScopeKey ? `${_taskFiltersBoard}:${_taskScopeKey}` : _taskFiltersBoard, next, browserLocal);
    _filteredList = _emptyFiltered(_taskFiltersBoard);
    _filteredSeq++;
    if (_queryActive()) _loadFilteredTasks(_taskFiltersBoard); else renderBoardTaskList();
}

/** The bar in its place above the list, shown for a board's tasks, told the filters and the counts. */
function _syncTaskBar(show, counts) {
    const host = document.getElementById('board-task-bar');
    if (!host) return;
    // With no tasks the bar has nothing to search, but + Task stays reachable: the button alone, at the right (a live agent or a team always gets the section)
    const solo = host.querySelector('.board-task-solo');
    if (!show) {
        if (_taskBar && _taskBar.node.parentElement === host) _taskBar.node.remove();
        if (!solo) { const d = document.createElement('div'); d.className = 'board-task-solo'; d.append(TV.newTaskButton({ small: true })); host.append(d); }
        return;
    }
    if (solo) solo.remove();
    if (!_taskBar) {
        const board = _taskFiltersBoard;
        _taskBar = TV.tasksToolbar(agentTaskScope() ? 'agent' : 'agent-team', _setTaskFilters, { onPanel: open => savePanelOpen('tasks', board, open) });
        _taskBar.setOpen(loadPanelOpen('tasks', board)); // the panel is left as it was for this board (#5293)
        // The one top row (#7924): the search, the Filters icon, then + Task; Hide done is a control of the Filters panel, not a title row
        _taskBar.setHeader(null, [TV.newTaskButton({ small: true })]);
        const hide = document.createElement('div');
        hide.innerHTML = '<label class="board-task-hide-toggle"><input type="checkbox" data-on-change="task-hide-done"> <span class="board-task-hide-text">Hide done</span></label>';
        _hideDoneEl = hide.firstElementChild;
        _taskBar.setExtras([_hideDoneEl]);
        _syncHideDone(_hideDoneLast.count, _hideDoneLast.hidden);
    }
    if (_taskBar.node.parentElement !== host) host.append(_taskBar.node);
    _applyAgentChoices();
    _taskBar.set(_taskFilters, counts);
    // The worker scope is fixed: a board-wide assignee control would promise a view this dock never shows.
    const assignee = host.querySelector('#tk-assignee');
    if (assignee) assignee.closest('label').hidden = !!agentTaskScope();
}

// The Agent select's options (#8003): the board's members (read once per board) and whoever has a task on screen, and the agent in the filter so it always shows.
let _dockMembers = { board: '', names: [] };
function _applyAgentChoices() {
    if (!_taskBar) return;
    const names = [...new Set([...(_dockMembers.board === _taskFiltersBoard ? _dockMembers.names : []), ...(state.currentBoardTasks || []).map(t => t.assigned_to), _taskFilters.assignee].filter(n => typeof n === 'string' && n))].sort();
    _taskBar.setOptions('assignee', names, {});
    const board = _taskFiltersBoard;
    if (board && _dockMembers.board !== board) {
        _dockMembers = { board, names: [] }; // asked once: a failed read leaves the names of the tasks
        boardFetch(board, '/subscribers').then(r => (r.ok ? r.json() : [])).then(d => {
            const list = Array.isArray(d) ? d : (d && Array.isArray(d.subscribers) ? d.subscribers : []);
            if (_dockMembers.board !== board) return;
            _dockMembers.names = list.map(s => s && s.subscriber_id).filter(n => typeof n === 'string' && n);
            _applyAgentChoices();
        }).catch(() => {});
    }
}

/** "Load more": the next page of done tasks (or of the filtered list). */
async function loadMoreBoardTasks() {
    if (_queryActive()) { if (_filteredHasMore() && !_filteredList.busy) await _loadFilteredTasks(_boardList.board, { append: true }); return; }
    const board = _boardList.board;
    const cursor = _boardList.nextCursor;
    if (!board || !cursor || _boardList.busyMore) return;
    const boardPage = _boardList; boardPage.busyMore = true; boardPage.moreError = '';
    renderBoardTaskList();
    const seq = _boardTasksLoadSeq;
    let data;
    try {
        data = await _fetchTaskPage(board, cursor);
    } catch (e) {
        boardPage.moreError = 'Could not load more tasks. Try again.';
        showToast(boardPage.moreError, true);
    } finally { boardPage.busyMore = false; }
    if (!data) { if (_boardList === boardPage) renderBoardTaskList(); return; }
    // The user moved to another board meanwhile, or the list was reloaded from scratch.
    if (_boardList.board !== board || _boardList.nextCursor !== cursor || seq !== _boardTasksLoadSeq) return;
    _boardList.older = [..._boardList.older, ...(data.tasks || [])];
    _boardList.pages++;
    _boardList.nextCursor = data.next_cursor || '';
    _setBoardTasks();
    renderBoardTaskList();
}

let _sort = defaultSort(); // the chosen column and its direction (task_list_data.js)
let _hideCompleted = browserLocal.get('coral-hide-completed') === 'true';
let _hideDoneEl = null; // the Filters panel's Hide done (a label with its checkbox), once the bar is built (#7924)

export function _toggleTaskSort(field) {
    _sort = nextSort(_sort, field);
    renderBoardTaskList();
}

export function _toggleHideCompleted() {
    _hideCompleted = !_hideCompleted;
    browserLocal.set('coral-hide-completed', _hideCompleted);
    renderBoardTaskList();
}

/** Nothing to show: hide the section, or say so for a live agent or a team (and a busy board). */
function _renderEmptyTaskList(container, section) {
    // Drop the previous agent's rows too; hiding alone leaves them in the DOM.
    const countEl = document.getElementById('task-bar-count');
    if (countEl && countEl.textContent !== '') countEl.textContent = '';
    const live = state.selectedTeam || (state.currentSession && state.currentSession.type === 'live');
    if (!live) {
        if (section) section.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    // A live agent always gets the section, so "+ Task" is reachable
    if (section) section.style.display = '';
    _syncHideDone(0, true);
    morphHtml(container, _boardList.busy
        ? `<div class="board-task-empty board-task-busy" role="status">${escapeHtml(_boardList.busy)}</div>`
        : '<div class="board-task-empty">No tasks yet</div>');
    return;
}

/** Hide done in the Filters panel: offered when there are done tasks and no search runs (the status filter says what to show then); its count, its checkbox and the icon's badge follow. */
let _hideDoneLast = { count: 0, hidden: true }; // the last state asked for: a bar built after the list was drawn takes it
function _syncHideDone(completedCount, hidden) {
    _hideDoneLast = { count: completedCount, hidden };
    if (!_hideDoneEl) return;
    _hideDoneEl.hidden = hidden;
    const text = `Hide done (${completedCount})`, t = _hideDoneEl.querySelector('.board-task-hide-text'), box = _hideDoneEl.querySelector('input');
    if (t && t.textContent !== text) t.textContent = text;
    if (box && box.checked !== _hideCompleted) box.checked = _hideCompleted;
    if (_taskBar) _taskBar.setExtraOn(!hidden && _hideCompleted ? 1 : 0);
}
function _renderTaskListChrome(section, completedCount, querying = false) {
    _syncHideDone(completedCount, !(completedCount > 0 && !querying));
}

/** The dock keeps its own task fields; the shared component owns the table layout. */
function _taskTable(tasks, footer) {
    const span = (cls, value) => DT.el('span', cls, value);
    const key = t => `${t._source}:${t.subagent_id || t.id}`;
    // The dock keeps one line: state, ellipsized title, and assigned agent.
    const FIELD = { task: 'id', who: 'assignee' }, COLUMN = { id: 'task', assignee: 'who' };
    dockTaskTableState.sort = _sort.explicit ? { key: COLUMN[_sort.field] || _sort.field, dir: _sort.asc ? 'asc' : 'desc' } : null;
    const tweak = columns => {
        const [stateCol, taskCol, whoCol] = columns;
        stateCol.sort = false;
        stateCol.width = 'content'; // the dock knows a review is asked for from the task's workflow, which the shared word reads from review_requested
        stateCol.cell = t => { const word = taskStatusWord(t.status, reviewRequested(t)), chip = DT.chip(word, statusClass(word)), st = taskStatus(t); chip.classList.add('board-task-status-wrap'); chip.title = st.detail; chip.setAttribute('aria-label', spoken(word, st)); return chip; };
        taskCol.firstDir = 'desc';
        taskCol.cell = t => {
            const cell = DT.el('span', 'dt-title-cell'), description = span('board-task-desc dt-title-content');
            const name = t.title || t.description || '';
            const b = DT.primaryButton(name, `${t._source === 'subagent' ? 'Open subagent' : 'Open task'}: ${name}, ${spoken(taskStatusWord(t.status, reviewRequested(t)), taskStatus(t))}`);
            b.classList.add('board-task-open', 'board-task-name');
            cell.title = t._source === 'subagent' ? _subagentTooltip(t) : t.body || t.body_preview || '';
            description.title = cell.title;
            description.append(b);
            cell.append(description);
            return cell;
        };
        if (whoCol) { whoCol.width = 'content'; whoCol.firstDir = 'desc'; whoCol.when = t => !!TV.doerOf(t); whoCol.cell = t => (TV.doerOf(t) ? TV.whoCell(t) : ''); } // the same circles as the Tasks tab (#8507); an empty Who is an empty cell, not a dash (#8003)
    };
    const table = TV.tasksTable(agentTaskScope() ? 'agent' : 'agent-team', tasks, { label: 'Agent tasks', fold: 'none', tweak, rowKey: key, rowName: t => t.title || t.description || '',
        footer, current: previewTask?.project === _currentBoardKey() ? previewTask.key : null, state: dockTaskTableState, onSort: field => _toggleTaskSort(FIELD[field] || field), bare: true, sortBar: false, defaultSortLabel: _queryActive() && _taskFilters.sort !== 'open' ? taskSortLabel[_taskFilters.sort] : 'Open first, newest first' });
    // Keep the existing action dispatcher and identifiers: opening a board task,
    // personal task or subagent retains its own detail action.
    const byKey = new Map(tasks.map(t => [key(t), t]));
    for (const row of table.el.querySelectorAll('tbody tr')) {
        const t = byKey.get(row.dataset.key); if (!t) continue;
        row.classList.add('board-task-item', 'dt-row-open');
        if (t._source === 'subagent') { row.setAttribute('data-on-click', 'task-subagent-open'); row.dataset.subagentId = t.subagent_id || ''; row.classList.add('board-task-subagent'); }
        else { row.setAttribute('data-on-click', 'task-open'); row.dataset.kind = t._source; row.dataset.taskId = Number(t.id); }
    }
    return table.el;
}

/** Shared quiet footer: the next page arrives when this row scrolls into view. */
function _taskFooter(querying, scope, shown, total) {
    const hasMore = querying ? _filteredHasMore() && !(scope && _hideCompleted && !isQuery(_taskFilters) && !_filteredList.cursor) : _boardList.nextCursor && !_hideCompleted;
    if (!hasMore) return undefined;
    const busy = querying ? _filteredList.busy : _boardList.busyMore;
    const error = querying ? _filteredList.error : _boardList.moreError;
    return { text: error || `Showing ${shown} of ${total}`, auto: !error,
        more: { label: error ? 'Try again' : 'Load more', busy: !!busy, run: loadMoreBoardTasks } };
}

/** The badge: done / all, from the server's totals for the board. */
function _updateTaskCount(boardTasks, otherTasks, completedCount) {
    const countEl = document.getElementById('task-bar-count');
    if (countEl) {
        const scope = agentTaskScope();
        const boardTotal = scope && _boardList.scopeKey !== scope.key ? 0 : _boardList.totalOpen !== null && _boardList.totalCompleted !== null
            ? _boardList.totalOpen + _boardList.totalCompleted : boardTasks.length;
        const total = boardTotal + otherTasks.length;
        const count = scope ? Math.max(0, total - completedCount) : completedCount;
        const word = scope ? 'open' : 'done';
        const countText = total > 0 ? `${count}/${total}` : '';
        if (countEl.textContent !== countText) countEl.textContent = countText; // same text: no new text node, no layout
        const tab = document.getElementById('agentic-tab-tasks'); // the badge in words (#7182): "1/4" says nothing to a screen reader or a first look
        if (tab) { const name = total > 0 ? `Tasks, ${count} of ${total} ${word}` : 'Tasks'; if (tab.getAttribute('aria-label') !== name) tab.setAttribute('aria-label', name); const tip = total > 0 ? `${count} of ${total} ${word}` : ''; if (countEl.title !== tip) countEl.title = tip; }
    }
}

export function renderBoardTaskList() {
    const container = document.getElementById('board-task-list');
    if (!container) return;

    // Merge board tasks and agent tasks into a unified list
    const querying = _queryActive();
    const scope = agentTaskScope();
    const scopedBaseReady = !scope || _boardList.scopeKey === scope.key;
    const boardTasks = (querying ? _filteredList.rows : state.currentBoardTasks || []).filter(t => !scope || (scope.assignee && t.assigned_to === scope.assignee)).map(t => ({ ...t, _source: 'board' }));
    const agentDisplayName = state.currentSession ? (state.currentSession.display_name || state.currentSession.name) : '';
    const agentTasks = (state.currentAgentTasks || []).map(t => ({
        ...t,
        _source: 'agent',
        // Normalize agent task fields to match board task shape
        status: _agentTaskStatus(t),
        priority: t.priority || null,
        assigned_to: t.display_name || t.agent_name || agentDisplayName || null,
        created_at: t.created_at,
    }));

    const subagentTasks = (state.currentSubagents || []).map(sa => subagentToTaskRow(sa, agentDisplayName));

    const includeAgentTasks = !querying || (scope && !isQuery(_taskFilters));
    const allTasks = includeAgentTasks ? [...boardTasks, ...agentTasks, ...(scope ? [] : subagentTasks)] : boardTasks; // a search is about the board's tasks
    const isDone = t => t.status === 'completed' || t.status === 'skipped';
    const otherTasks = includeAgentTasks ? [...agentTasks, ...(scope ? [] : subagentTasks)] : [];
    // The board's done tasks are counted by the server: only a page of them is loaded (#3269).
    const boardDoneLoaded = boardTasks.filter(isDone).length;
    const boardDoneTotal = scopedBaseReady ? (_boardList.totalCompleted ?? boardDoneLoaded) : 0;
    const completedCount = boardDoneTotal + otherTasks.filter(isDone).length;
    const tasks = filterAndSortTasks(allTasks, _sort, { querying: querying && (!scope || isQuery(_taskFilters)), hideCompleted: _hideCompleted });
    const section = document.getElementById('board-tasks-section');
    const hasBoard = !!_boardList.board; // the bar belongs to the board whose tasks are listed
    // The bar's counts: what matches of what the board has (the server's totals); with nothing narrowing it, the board's own total.
    const boardAll = !scopedBaseReady ? 0 : _boardList.totalOpen !== null && _boardList.totalCompleted !== null ? _boardList.totalOpen + _boardList.totalCompleted : boardTasks.length;
    const barCounts = querying ? { matched: _filteredList.total ?? boardTasks.length, all: Math.max(boardAll, _filteredList.total ?? 0), truncated: _filteredList.truncated } : { matched: boardAll, all: boardAll };

    _updateTaskCount(boardTasks, otherTasks, completedCount);

    if (querying && allTasks.length === 0 && section) {
        // Nothing matches (or the search is still on its way): the bar stays, so the search can be changed.
        section.style.display = '';
        _renderTaskListChrome(section, 0, true);
        _syncTaskBar(true, barCounts);
        const ownDefault = scope && !isQuery(_taskFilters);
        morphHtml(container, `<div class="board-task-empty" role="status">${escapeHtml(_filteredList.error || (_filteredList.busy ? (ownDefault ? 'Loading tasks…' : 'Searching tasks…') : (ownDefault ? 'No tasks assigned to this agent.' : 'No tasks match this search.')))}</div>`);
        return;
    }
    if (allTasks.length === 0) {
        _syncTaskBar(false);
        _renderEmptyTaskList(container, section);
        return;
    }
    if (section) section.style.display = '';

    // Render hide-done toggle in the section header
    _renderTaskListChrome(section, completedCount, querying && (!scope || isQuery(_taskFilters)));
    _syncTaskBar(hasBoard, barCounts);

    // Older done tasks come a page at a time (#3269).
    const more = _taskFooter(querying, scope, tasks.length, querying ? (_filteredList.total ?? boardTasks.length) + otherTasks.length : boardAll + otherTasks.length);
    const signature = JSON.stringify([tasks, _liveCosts, _taskFilters.sort, _sort.field, _sort.asc, _sort.explicit, more,
        tasks.map(t => [whenText(t.created_at), t._source === 'board' ? _claimedFor(t) : '', t.goal_id ? goalTitle(_goalBoard, t.goal_id) : ''])]);
    if (container.dataset.drawn === signature && container.querySelector('.dt-table')) return;
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const held = active && { row: active.closest('tr')?.dataset.key, sort: active.dataset.key, more: active.classList.contains('dt-more'), sortbar: active.closest('.dt-sortbar') ? active.tagName : '' };
    const table = _taskTable(tasks, more);
    // Keep the visible sort controls while the new table's ResizeObserver catches up.
    table.classList.toggle('dt-folded', !!container.querySelector('.dt-box.dt-folded'));
    container.replaceChildren(table); container.dataset.drawn = signature;
    if (held) {
        const target = held.row ? [...container.querySelectorAll('tbody tr')].find(r => r.dataset.key === held.row)?.querySelector('.dt-primary')
            : held.more ? container.querySelector('.dt-more') || container.querySelector('tbody tr:last-child .dt-primary') : held.sortbar ? container.querySelector(`.dt-sortbar ${held.sortbar.toLowerCase()}`) : [...container.querySelectorAll('.dt-sort')].find(b => b.dataset.key === held.sort);
        (target?.hidden ? container.querySelector('.dt-sortbar-select') : target || container.querySelector('.dt-primary, button'))?.focus({ preventScroll: true });
    }

}
