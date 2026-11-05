import { cachedServerAccess } from './hub_access.js';
/* Changed files panel — load and render per-agent file diffs */

import { state } from './state.js';
import { isSignedOut } from './overload.js';
import { worktreeMode, setWorktreeMode } from './agent_file_api.js';
import { deriveSessionState } from './render.js';
import { escapeHtml, escapeAttr, showToast, refusedTooLarge } from './utils.js';
import { registerActions, textOf } from './actions.js';
import { fetchFileList, fuzzyFilter } from './file_mention.js';
import { initFilesSourcePicker, syncFilesSourceTeam } from './team_artifacts.js';
import { fileIconHtml } from './file_explorer.js';
import { openPreviewTab, openArtifactTab, setPreviewSession, refreshOpenFiles } from './preview_pane.js';
import { storeKey, readStars, writeStars } from './local_store.js';
import { importOnce } from './import_once.js';
import { morphHtml } from './dom_morph.js';
import { serverFetch, serverForSession, sessionServer, currentServer, isCloud, dropBody } from './server_base.js';

let _currentFiles = [];
const _keyOf = s => s ? `${sessionServer(s)}|${s.name || ''}|${s.session_id || ''}` : ''; // the same key as session_header_updates.js whereKey
let _wtFor = ''; // the agent _worktree was read for
const paintWhere = () => { importOnce('./session_header_updates.js').then(m => m.setFilesWorktree(_worktree, _wtFor)).catch(() => {}); };
const forThisAgent = (k = _keyOf(state.currentSession)) => { if (_wtFor !== k) { _worktree = null; _wtFor = k; paintWhere(); } return k; }; // another agent or computer: nothing of the last one's worktree stays // the one line at the top of Files names the followed worktree (#12690)
let _worktree = null; // the worktree the agent works in, when it is not its launch folder: { path, name, branch, followed, launch } (#11351)
const _expandedFiles = new Set(); // the paths whose diff is open under their row (#11350): kept across the list's redraws, and by path so a file that moves in the list keeps it
let _actionsOpenFor = ''; // the path whose row has its Copy, Preview and Edit open on a phone (#7652): kept across the list's redraws
// A phone's row has one "More" button in place of the three icon buttons, so the name keeps the row (#7652); it opens them on a line under the row.
const moreButton = (path, name) => { const label = `More for ${name}`; return `<button type="button" class="btn btn-quiet btn-icon btn-xs file-more-btn ic-more" data-on-click="file-more" data-path="${escapeAttr(path)}" aria-expanded="${escapeAttr(String(_actionsOpenFor === path))}" aria-label="${escapeAttr(label)}" title="More"></button>`; }; // the three dots are drawn in CSS (.ic-more): no icon font name to subset
/** A file row's Share as artifact button (#10269): it names its file, as the row's other buttons do. */
const shareButton = (path, name) => { const label = `Share ${name} as an artifact`; return `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-share" data-path="${escapeAttr(path)}" title="Share as artifact" aria-label="${escapeAttr(label)}"><span class="material-icons" aria-hidden="true">link</span></button>`; };
let _searchTimeout = null;
let _renderTimer = null;

/* ── Starred files (persisted in localStorage per session) ── */

// The signed-in account's (local_store.js, #3681), stored with when they were last changed, so an
// untouched list ages out.
function _starKey() {
    const sid = state.currentSession && state.currentSession.session_id;
    return sid ? storeKey(`coral-starred-files-${sid}`) : null;
}

function _getStarredFiles() {
    const key = _starKey();
    return key ? readStars(key).files : [];
}

function _setStarredFiles(files) {
    const key = _starKey();
    if (key) writeStars(key, files);
}

export function isFileStarred(filepath) {
    return _getStarredFiles().includes(filepath);
}

export function toggleStarFile(filepath) {
    const starred = _getStarredFiles();
    const idx = starred.indexOf(filepath);
    if (idx >= 0) {
        starred.splice(idx, 1);
    } else {
        starred.push(filepath);
    }
    _setStarredFiles(starred);
    renderStarredFiles();
    renderChangedFiles();
    // Re-render search results if visible
    const searchResults = document.getElementById('files-search-results');
    if (searchResults && searchResults.style.display !== 'none') {
        const items = searchResults.querySelectorAll('.file-star-btn');
        const starredSet = new Set(starred);
        items.forEach(btn => {
            const fp = btn.dataset.filepath;
            btn.classList.toggle('starred', starredSet.has(fp));
            btn.textContent = starredSet.has(fp) ? '★' : '☆';
        });
    }
}

function renderStarredFiles() {
    const container = document.getElementById('starred-files-list');
    if (!container) return;
    const starred = _getStarredFiles();
    if (starred.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = '';
    container.innerHTML = `<div class="group-head starred-section-label">★ Starred</div>` +
        starred.map(filepath => {
            const { dir, name } = splitPath(filepath);
            const unstarLabel = `Unstar ${name}`, copyLabel = `Copy path of ${name}`, previewLabel = `Preview ${name}`, editLabel = `Edit ${name}`;
            const starBtn = `<button class="btn btn-quiet btn-icon btn-xs file-star-btn starred" data-filepath="${escapeAttr(filepath)}" data-on-click="file-star" data-path="${escapeAttr(filepath)}" title="Unstar" aria-label="${escapeAttr(unstarLabel)}">★</button>`; // each button names its file: a list of rows must not read as the same four buttons (#6152)
            const copyBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-copy" data-path="${escapeAttr(filepath)}" title="Copy path" aria-label="${escapeAttr(copyLabel)}"><span class="material-icons" aria-hidden="true">content_copy</span></button>`;
            const previewBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-preview" data-path="${escapeAttr(filepath)}" title="Preview" aria-label="${escapeAttr(previewLabel)}"><span class="material-icons" aria-hidden="true">visibility</span></button>`;
            const editBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-edit" data-path="${escapeAttr(filepath)}" title="Edit" aria-label="${escapeAttr(editLabel)}"><span class="material-icons" aria-hidden="true">edit</span></button>`;
            const shareBtn = shareButton(filepath, name);
            return `<div class="file-item file-starred${escapeAttr(_actionsOpenFor === filepath ? ' actions-open' : '')}" data-on-click="file-open" role="button" tabindex="0" data-key-click data-path="${escapeAttr(filepath)}">
                ${starBtn}
                <div class="file-path-wrap">
                    <span class="file-name">${escapeHtml(name)}</span>
                    ${dir ? `<span class="file-dir">${escapeHtml(dir)}</span>` : ''}
                </div>
                ${moreButton(filepath, name)}
                <div class="file-action-btns">${copyBtn}${previewBtn}${editBtn}${shareBtn}</div>
            </div>`;
        }).join('');
}

/* ── File search ── */

let _searchResults = [];      // current dropdown results
let _searchSelectedIdx = 0;   // selected index in dropdown

async function searchRepoFiles(query) {
    if (!query || !state.currentSession || state.currentSession.type !== 'live') {
        _hideSearchDropdown();
        return;
    }

    const files = await fetchFileList();
    const matches = fuzzyFilter(files, query);
    clearTimeout(_renderTimer);
    _renderTimer = setTimeout(() => _renderSearchDropdown(matches, query), 30);
}

function _renderSearchDropdown(files, query) {
    const dropdown = document.getElementById('files-search-dropdown');
    if (!dropdown) return;

    const hasExactMatch = files.some(f => f === query);
    const looksLikePath = query.includes('/') || query.includes('.');

    let html = '';

    // Build results list
    _searchResults = [];
    files.slice(0, 50).forEach((filepath, i) => {
        const cls = i === _searchSelectedIdx ? 'file-mention-item selected' : 'file-mention-item';
        _searchResults.push({ path: filepath, type: 'file' });
        html += `<div class="${cls}" data-index="${Number(i)}">${escapeHtml(filepath)}</div>`;
    });

    // +create option at the end
    if (query && looksLikePath && !hasExactMatch) {
        const createIdx = _searchResults.length;
        _searchResults.push({ path: query, type: 'create' });
        const cls = createIdx === _searchSelectedIdx ? 'file-mention-item selected' : 'file-mention-item';
        html += `<div class="${cls}" data-index="${Number(createIdx)}" style="color:var(--accent)">+ Create ${escapeHtml(query)}</div>`;
    }

    if (_searchResults.length === 0) {
        _hideSearchDropdown();
        return;
    }

    _searchSelectedIdx = Math.min(_searchSelectedIdx, _searchResults.length - 1);
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    // Click handlers
    dropdown.querySelectorAll('.file-mention-item').forEach(el => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            _selectSearchItem(parseInt(el.dataset.index));
        });
    });
}

function _selectSearchItem(index) {
    if (index < 0 || index >= _searchResults.length) return;
    const item = _searchResults[index];

    if (item.type === 'create') {
        _hideSearchDropdown();
        _createFile(item.path);
    } else {
        _hideSearchDropdown();
        openFilePreview(item.path);
    }
}

function _hideSearchDropdown() {
    const dropdown = document.getElementById('files-search-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    _searchResults = [];
    _searchSelectedIdx = 0;
    // Also hide the old inline results container
    const el = document.getElementById('files-search-results');
    if (el) el.style.display = 'none';
}

export function initFileSearch() {
    initFilesSourcePicker(openFilePreview);
    const input = document.getElementById('files-search-input');
    if (!input || input.dataset.searchBound) return;
    input.dataset.searchBound = '1';

    input.placeholder = 'Search files...';

    function onSearchInput() {
        clearTimeout(_searchTimeout);
        const q = input.value.trim();
        if (!q) {
            _hideSearchDropdown();
            return;
        }
        _searchTimeout = setTimeout(() => searchRepoFiles(q), 200);
    }

    input.addEventListener('input', onSearchInput);
    input.addEventListener('keyup', onSearchInput);
    input.addEventListener('keydown', (e) => {
        const dropdown = document.getElementById('files-search-dropdown');
        const isVisible = dropdown && dropdown.style.display !== 'none';

        if (e.key === 'Escape') {
            if (isVisible) {
                e.preventDefault();
                _hideSearchDropdown();
            } else {
                input.value = '';
            }
            return;
        }

        if (!isVisible || _searchResults.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _searchSelectedIdx = Math.min(_searchSelectedIdx + 1, _searchResults.length - 1);
            _updateSearchSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            _searchSelectedIdx = Math.max(_searchSelectedIdx - 1, 0);
            _updateSearchSelection();
        } else if (e.key === 'Tab' || e.key === 'Enter') {
            e.preventDefault();
            _selectSearchItem(_searchSelectedIdx);
        }
    });

    input.addEventListener('focus', async () => {
        if (!input.value.trim()) {
            // Show the file listing on focus
            if (!state.currentSession || state.currentSession.type !== 'live') return;
            const files = await fetchFileList();
            if (files && files.length > 0) {
                _renderSearchDropdown(files.slice(0, 50), '');
            }
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(_hideSearchDropdown, 200);
    });
}

function _updateSearchSelection() {
    const dropdown = document.getElementById('files-search-dropdown');
    if (!dropdown) return;
    dropdown.querySelectorAll('.file-mention-item').forEach((el, i) => {
        el.classList.toggle('selected', i === _searchSelectedIdx);
    });
    const selected = dropdown.querySelector('.file-mention-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// The list was refused as too large to check through Coral Hub (#3718): it says so, not "No changed files".
let _filesRefused = false;
let _notGit = false; // the folder is not a git repository (#6072): there is nothing to compare, so the panel says so instead of "0 files changed vs HEAD~1"

export async function loadChangedFiles(agentName, sessionId, quiet = false) { // quiet: the watch's read (#10485): nothing is drawn unless the list moved
    if (!agentName) return;
    if (state.currentSession && state.currentSession.type === 'live' && filesPanelShowing()) watchFiles();
    if (_filesStale) { _filesStale = false; return refreshChangedFiles(quiet); } // files changed while the panel was not showing: the server's cached list may predate them
    _filesStale = false;
    const sid = sessionId || (state.currentSession && state.currentSession.session_id);
    const mine = `${serverForSession(agentName, sid)}|${agentName}|${sid || ''}`; // the agent this read was ASKED for (computer, name, session), not whichever is selected when it answers (#12690, UI Reviewer)
    const staleRead = () => !!state.currentSession && _keyOf(state.currentSession) !== mine; // an agent is open and it is not the one this read was asked for
    if (staleRead()) return; // asked for an agent that is no longer the open one
    forThisAgent(mine);
    try {
        const params = new URLSearchParams();
        if (sid) { params.set("session_id", sid); params.set("worktree", worktreeMode(sid)); }
        const qs = params.toString() ? `?${params}` : "";
        const resp = await serverFetch(serverForSession(agentName), `/api/sessions/live/${encodeURIComponent(agentName)}/files${qs}`);
        _filesRefused = !resp.ok && await refusedTooLarge(resp);
        if (!resp.ok) { dropBody(resp); throw new Error(`files fetch failed: ${resp.status}`); }
        const data = await resp.json();
        if (staleRead()) return; // the answer is for an agent that is no longer open
        const wasPaused = JSON.stringify(pausedNow()), wasTotal = _totalChanged;
        readPause(data, mine);
        if (quiet && JSON.stringify(data.files || []) === JSON.stringify(_currentFiles) && JSON.stringify(data.worktree || null) === JSON.stringify(_worktree) && wasPaused === JSON.stringify(pausedNow()) && wasTotal === _totalChanged) return;
        _currentFiles = data.files || [];
        _worktree = data.worktree && typeof data.worktree === 'object' ? data.worktree : null; paintWhere();
        _notGit = data.is_git === false;
        _compareLabel = (data.compare && typeof data.compare.label === 'string') ? data.compare.label : '';
        if (data.diff_mode) _cloudDiffMode = data.diff_mode;
    } catch (e) {
        if (staleRead()) return;
        if (_worktree) { _worktree = null; paintWhere(); } // a read that failed: the line does not go on naming a worktree it could not read
        if (quiet) return; // a read that failed in the background leaves the list as it was
        _currentFiles = [];
        _notGit = false;
    }
    renderStarredFiles();
    renderChangedFiles();
    refreshOpenFiles().catch(() => {}); // an open preview follows its file (#10334)
}

// The Files list follows the agent (#10268): it was read when the tab opened and on Refresh, so a reply that changed files left a stale "+2" until the button was pressed. The session feed
// carries each agent's changed-file count and its state: the list is read again when the open agent's count moves or its turn ends (working to anything else), once for a burst of rows.
let _followed = { id: '', count: null, working: false };
let _followTimer = null;
let _filesStale = false; // the agent changed files while the Files panel was not showing: the next look reads the list
const filesPanelShowing = () => { const p = document.getElementById('agentic-panel-files'); return !!p && p.classList.contains('active') && p.getClientRects().length > 0; };
const FOLLOW_DELAY_MS = 300;
// The follow's read: the route's refresh, not its cached list (the server keeps a list for 30 s or more, and the change that moved the count may be inside it). The refresh computes the diff, so it is
// one at a time with at least about 2 s between two (a reply and its edits come as a burst), and a request that comes while one runs is one more after it, not one each. A view-only viewer on a Hub
// has no refresh to call: it reads the list (#10268). Each read of the owner's watch is that refresh, so a few git commands about every 4 s while the panel shows (#10485).
const MIN_REFRESH_GAP_MS = 2000;
let _refreshBusy = false, _refreshQueued = false, _queuedQuiet = true, _refreshAt = 0;
// A folder git is too slow for is paused by the server (#13079): live updates stop, the list is the last one, and Refresh asks for one pass. The page makes no automatic request for it meanwhile.
let _paused = null, _pausedFor = '', _totalChanged = 0, _wantLive = false;
const pausedNow = () => (_paused && _pausedFor === _keyOf(state.currentSession) ? _paused : null);
const readPause = (data, key) => { _paused = data && data.paused && typeof data.paused === 'object' ? data.paused : null; _pausedFor = key; _totalChanged = Number(data && data.total_changed) || 0; };
async function followRead(quiet = false) {
    const cur = state.currentSession;
    if (cur && cur.hubReadOnly) { loadChangedFiles(cur.name, cur.session_id, quiet); return; }
    if (_refreshBusy) { _queuedQuiet = _refreshQueued ? _queuedQuiet && quiet : quiet; _refreshQueued = true; return; } // the one more after this read is quiet only when every request waiting for it was
    _refreshBusy = true;
    try {
        const wait = _refreshAt + MIN_REFRESH_GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _refreshAt = Date.now();
        await refreshChangedFiles(quiet, true);
    } finally {
        _refreshBusy = false;
        if (_refreshQueued) { _refreshQueued = false; followRead(_queuedQuiet); }
    }
}

// A file the person or another program changes moves no count until the git poller reads (every 15 s or more), so while the Files panel is showing the list is read again every few seconds and drawn only
// when it moved (#10485: the panel said 0 files changed for 8 s after a file was changed outside the agent). It stops by itself when the panel is not showing, the tab is hidden or the agent is not live.
const watchMs = () => Number(window.__coralFilesWatchMs) || 4000; // tests seed window.__coralFilesWatchMs before the panel shows
let _watch = null;
function watchFiles() {
    if (_watch) return;
    _watch = setInterval(() => { // interval-ok: only while the Files panel shows for a live agent in a visible tab; it clears itself otherwise
        const cur = state.currentSession;
        if (!cur || cur.type !== 'live' || document.hidden || isSignedOut() || !filesPanelShowing()) { clearInterval(_watch); _watch = null; _refreshBlock = null; return; } // a signed-out page makes no /api request (#12444)
        followRead(true);
    }, watchMs());
}

export function followChangedFiles(s) {
    if (!s || !state.currentSession || state.currentSession.type !== 'live') return;
    if (filesPanelShowing()) watchFiles();
    // Two counts say that files changed: the agent's own Write/Edit tool calls (changed_file_count) and the repository's uncommitted files (git_state.dirty, what the header chip shows), which also moves for a file the person
    // or another program changed (#10268: the chip said 1 changed and the list 0 after a reply, because only the first was watched).
    const id = s.session_id || s.name, count = (s.changed_file_count || 0) * 1000 + Math.min(999, (s.git_state && s.git_state.dirty) || 0), working = deriveSessionState(s) === 'working';
    const same = _followed.id === id;
    const moved = same && _followed.count !== null && _followed.count !== count, ended = same && _followed.working && !working;
    _followed = { id, count, working };
    if (!moved && !ended) return;
    clearTimeout(_followTimer);
    _followTimer = setTimeout(() => {
        const cur = state.currentSession;
        if (!cur || cur.type !== 'live' || (cur.session_id || cur.name) !== id) return;
        if (!filesPanelShowing()) { _filesStale = true; return; } // nobody is looking: it is read when the panel opens (switchAgenticTab), not at every reply
        followRead();
    }, FOLLOW_DELAY_MS);
}

// The Files tab's number has two sources that mean different things (#12683, the Operator: "the number is flashing in and out"): the session feed's changed_file_count, what the agent's own Write and Edit tool
// calls changed, told on every update and cleared at 0; and the list the panel shows, the files git says differ, drawn every round of the watch. When they disagree (an edit made by hand, a clean repository
// the agent wrote to) they took turns, once a round. So while the Files panel is showing, the list it shows owns the number and the feed's is not drawn; when it is not showing the feed moves the number,
// as before. Either way a number is written only when it changes, and the badge is empty only for a count of 0.
let _listOwner = '';
const setBadge = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
const currentViewId = () => { const cur = state.currentSession; return cur ? String(cur.session_id || cur.name || '') : ''; };
// the list draws the number: it is the owner of this session's badge from now on (while the panel shows)
function listCount(el, text) { _listOwner = currentViewId(); setBadge(el, text); }
export function updateChangedFileCount(count) {
    const id = currentViewId();
    if (id && _listOwner === id && filesPanelShowing()) return; // the list on screen owns the number
    setBadge(document.getElementById('files-bar-count'), count > 0 ? String(count) : '');
}

export function copyFilePath(filepath) {
    navigator.clipboard.writeText(filepath).then(() => {
        showToast('Path copied');
    });
}

function getStatusLabel(status) {
    const map = {
        'M': 'Modified',
        'A': 'Added',
        'D': 'Deleted',
        'R': 'Renamed',
        'C': 'Copied',
        '??': 'Untracked',
        'AM': 'Added',
        'MM': 'Modified',
        'agent_only': 'Agent edit',
    };
    return map[status] || status;
}

function getStatusClass(status) {
    if (status === 'A' || status === 'AM' || status === '??') return 'file-added';
    if (status === 'D') return 'file-deleted';
    if (status === 'R') return 'file-renamed';
    if (status === 'agent_only') return 'file-added';
    return 'file-modified';
}

function splitPath(filepath) {
    const lastSlash = filepath.lastIndexOf('/');
    if (lastSlash === -1) return { dir: '', name: filepath };
    return { dir: filepath.substring(0, lastSlash + 1), name: filepath.substring(lastSlash + 1) };
}

/* ── Helper: build API query string for the current session ── */

/** Show preview for a file. Everything opens as a tab in the bottom preview pane;
 *  `opts.diff` marks files from the changed-files list so the Diff mode is offered. */
export function openFilePreview(filepath, line, opts) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    if (/^coral:\/\/artifacts\/[a-f0-9]{64}$/i.test(filepath || '')) {
        openArtifactTab(filepath, { phoneFull: true });
        return;
    }
    openPreviewTab(filepath, line, opts);
}

// Called immediately after a session switch, before transcript/file requests.
export function syncFilesViewerSession() {
    syncFilesSourceTeam();
    setPreviewSession(state.currentSession?.type === 'live' ? state.currentSession.session_id : null);
    initFilesSourcePicker(openFilePreview);
}

/** Open file directly in edit mode (clicking the edit icon). */
export function openFileEdit(filepath, line, opts) {
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    openPreviewTab(filepath, line, { ...opts, mode: 'edit' });
}

/** Create a new file via the API and open it in the editor. */
// Exposed on window for onclick in rendered search results.
async function _createFile(filePath) {
    if (!filePath) return;
    const s = state.currentSession;
    if (!s || s.type !== 'live') return;

    try {
        const qs = new URLSearchParams({ filepath: filePath, session_id: s.session_id || '' });
        const resp = await serverFetch(sessionServer(s), `/api/sessions/live/${encodeURIComponent(s.name)}/file-content?${qs}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '' }),
        });
        const data = await resp.json();
        if (data.error) {
            showToast(data.error, true);
            return;
        }
        // Clear search, open the new file in editor, refresh file list
        const searchInput = document.getElementById('files-search-input');
        if (searchInput) searchInput.value = '';
        const searchResults = document.getElementById('files-search-results');
        if (searchResults) searchResults.style.display = 'none';
        openFileEdit(filePath);
        refreshChangedFiles();
    } catch (e) {
        showToast('Failed to create file', true);
    }
};

/* ── Refresh & Render ──────────────────────────────────────── */

// What each comparison lists, in the words of what it shows (#10054): "vs HEAD~1" and "vs merge-base" named refs and not the list, and on main listed only uncommitted changes. The server says what the
// comparison is in this repository too (compare.label): where that differs from the option (on the main branch there is nothing older than the last commit), the panel shows it beside the choice.
const _diffModes = ['uncommitted', 'last_commit', 'branch_point', 'previous_commit', 'main_head'];
const _diffModeLabels = { uncommitted: 'Since my last commit', last_commit: 'In my last commit', branch_point: 'Since I branched', previous_commit: 'Last commit + uncommitted', main_head: 'Compared with the main branch' };
let _compareLabel = '';

// On the hub the comparison base is the machine's own setting: it is read from the files response and changed through the one
// narrow route the hub allows (PUT /api/settings/git-diff-mode, Interact tier), not through the hub's per-user settings.
let _cloudDiffMode = '';

async function setGitDiffMode(mode) {
    if (!_diffModes.includes(mode)) return;
    if (isCloud()) {
        try {
            const resp = await serverFetch(currentServer(), '/api/settings/git-diff-mode', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
            });
            if (!resp.ok) { renderChangedFiles(); return; } // refused (view-only server): the wrapper has explained it; show the real mode again
            _cloudDiffMode = mode;
        } catch (e) { renderChangedFiles(); return; }
        refreshChangedFiles();
        return;
    }

    try {
        await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ git_diff_mode: mode }),
        });
        state.settings = { ...state.settings, git_diff_mode: mode };
    } catch (e) {
        console.error('Failed to save git diff mode:', e);
        return;
    }

    refreshChangedFiles();
}

// The diffs under the rows (#11350). A row's chevron opens or closes its own; Expand all stacks every file's in the list's order and Collapse all closes them. Done in place: the list is not drawn again.
const fileOf = path => _currentFiles.find(f => f.filepath === path);
let _drawnFor = ''; // the agent (name and session) the list on screen was last drawn for
const scrollerOf = el => { for (let e = el; e; e = e.parentElement) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) return e; return null; }; // the nearest ancestor that scrolls
const slotOf = (list, path) => [...list.querySelectorAll('.file-diff')].find(e => e.dataset.filepath === path);
function showExpanded(list, files) {
    importOnce('./inline_diff.js').then(m => { for (const f of files) if (_expandedFiles.has(f.filepath)) { const slot = slotOf(list, f.filepath); if (slot) m.showFileDiff(slot, f); } }).catch(() => {});
}
function paintExpansion(list, path) {
    const open = _expandedFiles.has(path);
    const btn = [...list.querySelectorAll('.file-expand-btn')].find(b => b.dataset.path === path);
    if (btn) {
        const name = splitPath(path).name;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.title = `${open ? 'Hide' : 'Show'} the changes`;
        btn.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the changes in ${name}`);
        const icon = btn.querySelector('.material-icons');
        if (icon) icon.textContent = open ? 'keyboard_arrow_up' : 'keyboard_arrow_down';
    }
    const slot = slotOf(list, path);
    const f = fileOf(path);
    if (!slot || !f) return;
    importOnce('./inline_diff.js').then(m => (open ? m.showFileDiff(slot, f) : m.hideFileDiff(slot))).catch(() => {});
}
function paintExpandAll() {
    const btn = document.querySelector('#changed-files-list .files-expand-all');
    if (!btn) return;
    const text = _currentFiles.length > 0 && _currentFiles.every(f => _expandedFiles.has(f.filepath)) ? 'Collapse all' : 'Expand all';
    if (btn.textContent !== text) { btn.textContent = text; btn.setAttribute('aria-label', `${text} the changes`); }
}
function toggleFileExpanded(path) {
    const list = document.getElementById('changed-files-list');
    if (!list || !path) return;
    if (_expandedFiles.has(path)) _expandedFiles.delete(path); else _expandedFiles.add(path);
    paintExpansion(list, path);
    paintExpandAll();
}
function toggleAllExpanded() {
    const list = document.getElementById('changed-files-list');
    if (!list) return;
    const all = _currentFiles.length > 0 && _currentFiles.every(f => _expandedFiles.has(f.filepath));
    for (const f of _currentFiles) { if (all) _expandedFiles.delete(f.filepath); else _expandedFiles.add(f.filepath); paintExpansion(list, f.filepath); }
    paintExpandAll();
}

// Which worktree the list is from (#11351) is the one line at the top of Files (session_header_updates.js setFilesWorktree, #12690), not a bar in the list.

// The switch between the two: the list is read again from the other folder, and the diffs opened under the rows of the first are closed.
function switchWorktree(mode) {
    const s = state.currentSession;
    if (!s || !s.session_id) return;
    setWorktreeMode(s.session_id, mode);
    _expandedFiles.clear();
    _currentFiles = [];
    _worktree = null; paintWhere();
    renderChangedFiles();
    refreshChangedFiles();
}

function _getGitDiffMode() {
    if (isCloud()) return _cloudDiffMode || 'branch_point';
    return (state.settings || {}).git_diff_mode || 'branch_point';
}

// Through the Coral Hub on a computer in View mode the refresh (a POST, an Interact route) is refused 403 access_mode and leaves an audit row each time (#12646, coral-hub's beta pass): the watch asked about
// every 2 s for as long as the panel showed. So once the page knows the computer is in View mode (its cached access) or a refresh was refused for the mode, this view stops asking: it reads the cached list
// (a GET) and says once, quietly, that the list may be out of date. The block ends when the panel stops showing (the watch ends: reopening asks again), for another agent or server, and when the
// access the page knows allows Interact again. The route stays Interact: no access changes here.
let _refreshBlock = null; // { key } while this view does not call the refresh
const refreshViewKey = (agentName, sessionId) => `${currentServer()}|${agentName}|${sessionId || ''}`;
function staleNoteHtml() {
    const pz = pausedNow();
    const paused = pz ? `<div class="files-stale-note files-paused-note" role="status"><span>Live updates paused: this repo is large (${escapeHtml(String(Math.max(pz.changes || 0, _currentFiles.length)).replace(/\B(?=(\d{3})+(?!\d))/g, ','))} changes) and reading it takes a while.</span> <button type="button" class="btn btn-small" data-on-click="files-refresh">Refresh</button> <button type="button" class="btn btn-small btn-quiet" data-on-click="files-live-on">Turn on live updates</button></div>` : '';
    return paused + (_refreshBlock ? '<div class="files-stale-note">This computer is in View mode, so Coral does not re-check its files from here: the list may be out of date.</div>' : '');
}
/** 'Turn on live updates' for a paused folder: one pass that also lets the poller and the page's follow take the folder up again (they pause it again if git is still slow). */
export function turnOnLiveFiles() { _wantLive = true; return refreshChangedFiles(); }
// whether this view must not call the refresh now; sets or clears the block from what the page knows. Draws the note once when it first appears.
function refreshBlockedFor(agentName, sessionId) {
    const key = refreshViewKey(agentName, sessionId);
    if (_refreshBlock && _refreshBlock.key !== key) _refreshBlock = null; // another agent or server
    const access = cachedServerAccess(currentServer());
    if (_refreshBlock && access && access.mayInteract) { _refreshBlock = null; renderChangedFiles(); } // the mode changed: ask again
    else if (!_refreshBlock && access && !access.mayInteract) { _refreshBlock = { key }; renderChangedFiles(); }
    return !!_refreshBlock;
}

export async function refreshChangedFiles(quiet = false, auto = false) { // quiet: the panel's own watch (#10485), which draws only when the list moved; auto: the page's own follow, not a person's Refresh
    if (!state.currentSession || state.currentSession.type !== 'live') return;
    if (auto && pausedNow()) return; // live updates are paused for this folder: nothing asks git until a person presses Refresh
    const live = _wantLive; _wantLive = false; // Turn on live updates asks once: a request that fails, is refused or never goes out must not leave live=on on the next ones
    const btn = quiet ? null : document.querySelector('.refresh-files-btn');
    if (btn) btn.classList.add('refreshing');

    const agentName = state.currentSession.name;
    const sessionId = state.currentSession.session_id;
    const mine = forThisAgent();

    if (refreshBlockedFor(agentName, sessionId)) { // View mode: the cached list, no POST (#12646)
        _filesStale = false;
        await loadChangedFiles(agentName, sessionId, quiet);
        if (btn) setTimeout(() => btn.classList.remove('refreshing'), 300);
        return;
    }
    try {
        const body = {};
        if (sessionId) body.session_id = sessionId;
        const resp = await serverFetch(
            currentServer(), `/api/sessions/live/${encodeURIComponent(agentName)}/files/refresh?worktree=${worktreeMode(sessionId)}${live ? '&live=on' : pausedNow() ? '&manual=1' : ''}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );

        if (resp.ok) {
            const data = await resp.json();
            if (_keyOf(state.currentSession) !== mine) { if (btn) btn.classList.remove('refreshing'); return; } // the answer is for an agent that is no longer open
            const wasPaused = JSON.stringify(pausedNow()), wasTotal = _totalChanged;
            readPause(data, mine);
            if (quiet && JSON.stringify(data.files || []) === JSON.stringify(_currentFiles) && JSON.stringify(data.worktree || null) === JSON.stringify(_worktree) && wasPaused === JSON.stringify(pausedNow()) && wasTotal === _totalChanged) return;
            _currentFiles = data.files || [];
            _worktree = data.worktree && typeof data.worktree === 'object' ? data.worktree : null; paintWhere();
            _notGit = data.is_git === false;
            _compareLabel = (data.compare && typeof data.compare.label === 'string') ? data.compare.label : '';
            if (data.diff_mode) _cloudDiffMode = data.diff_mode;
            renderStarredFiles();
            renderChangedFiles();
            refreshOpenFiles().catch(() => {});
        } else {
            if (resp.status === 403) { // refused for the mode (limited by the Hub or by the computer): do not ask again from this view
                const why = await resp.clone().json().catch(() => null);
                if (why && (why.limited_by === 'hub' || why.error === 'access_mode' || why.error === 'local_mode') && _keyOf(state.currentSession) === mine) { _refreshBlock = { key: refreshViewKey(agentName, sessionId) }; renderChangedFiles(); } // only while this agent is still the open one: another's refusal draws nothing on the agent now open
            }
            _filesStale = false;
            if (_keyOf(state.currentSession) === mine) await loadChangedFiles(agentName, sessionId); // the answer is for an agent that is no longer open: no read for it (#12690)
        }
    } catch (e) {
        if (_keyOf(state.currentSession) === mine) await loadChangedFiles(agentName, sessionId); // another agent was opened meanwhile: no read for this one
    }

    if (btn) setTimeout(() => btn.classList.remove('refreshing'), 300);
}

// A late file read can arrive after the person started typing. Keep polling/model updates live,
// but paint the list once typing pauses; a first 500-row population cannot reuse old rows.
const FILES_TYPING_IDLE_MS = 300;
let _lastTypingAt = -Infinity, _typingPaintTimer = 0, _typingPaintFor = '';
const typingField = e => !!e && (e.id === 'command-input' || e.classList?.contains('xterm-helper-textarea'));
function queueTypingPaint() {
    clearTimeout(_typingPaintTimer);
    _typingPaintFor = _keyOf(state.currentSession);
    _typingPaintTimer = setTimeout(() => { _typingPaintTimer = 0; if (_typingPaintFor === _keyOf(state.currentSession)) renderChangedFiles(); }, FILES_TYPING_IDLE_MS);
}
function noteFilesTyping(e) {
    if (!typingField(e.target)) return;
    _lastTypingAt = performance.now();
    if (_typingPaintTimer) {
        if (_typingPaintFor === _keyOf(state.currentSession)) queueTypingPaint();
        else { clearTimeout(_typingPaintTimer); _typingPaintTimer = 0; } // the pending list belonged to another agent
    }
}
document.addEventListener('input', noteFilesTyping, true);
document.addEventListener('keydown', e => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key?.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(e.key) || e.isComposing)) noteFilesTyping(e);
}, true);
 function renderChangedFiles() {
    if (typingField(document.activeElement) && performance.now() - _lastTypingAt < FILES_TYPING_IDLE_MS) { queueTypingPaint(); return; }
    if (_typingPaintTimer) { clearTimeout(_typingPaintTimer); _typingPaintTimer = 0; }
    const list = document.getElementById('changed-files-list');
    const titleEl = document.getElementById('changed-files-title');
    const countEl = document.getElementById('files-bar-count');
    if (!list) return;

    // Not a git folder (#6072): there is no comparison to choose and no count of changes to give. The folder's recently changed files, newest first, stand in (#10256); with none, the panel says so.
    const plain = _notGit && _currentFiles.length > 0;
    if (_notGit && !plain) {
        const shell = state.currentSession && state.currentSession.agent_type === 'terminal'; // a terminal has no changes to list: no talk of git for a shell (#10077)
        if (titleEl) { titleEl.textContent = shell ? 'No changes to list' : 'Not a git folder'; titleEl._html = ''; }
        listCount(countEl, '');
        list.innerHTML = staleNoteHtml() + `<div class="empty-state empty-state-tight">${shell ? 'A terminal does not track changed files. Start an agent in this folder to see its changes.' : 'No files changed here this week. Changes show once the folder is a git repository, and an agent can also share a file with you as an artifact.'}</div>`;
        return;
    }

    const files = plain
        ? _currentFiles.slice().sort((a, b) => String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')) || a.filepath.localeCompare(b.filepath))
        : _currentFiles.slice().sort((a, b) => a.filepath.localeCompare(b.filepath));
    if (plain) {
        const html = `<span class="changed-files-count">${files.length} recent file${files.length !== 1 ? 's' : ''}</span><span class="changed-files-count files-compare-note">Not a git folder: files changed this week</span>`;
        if (titleEl && titleEl._html !== html) { titleEl.innerHTML = html; titleEl._html = html; }
        listCount(countEl, String(files.length));
    }

    if (titleEl && !plain) {
        const diffMode = _getGitDiffMode();
        const options = _diffModes.map(m =>
            `<option value="${escapeAttr(m)}"${m === diffMode ? ' selected' : ''}>${escapeHtml(_diffModeLabels[m])}</option>`
        ).join('');
        const totals = files.reduce(
            (acc, f) => ({ adds: acc.adds + (f.additions || 0), dels: acc.dels + (f.deletions || 0) }),
            { adds: 0, dels: 0 }
        );
        const modeSelect = `<select class="field field-dense diff-mode-select" data-on-change="diff-mode" title="${escapeAttr(_compareLabel || 'What the list compares')}" aria-label="Compare">${options}</select>`;
        // where the server's words differ from the chosen option's (on the main branch), they are said beside it, so the list is never read as something it is not
        const compareNote = _compareLabel && _compareLabel !== _diffModeLabels[diffMode] ? `<span class="changed-files-count files-compare-note">${escapeHtml(_compareLabel)}</span>` : '';
        const stats = files.length > 0
            ? `<span class="file-adds">+${totals.adds}</span><span class="file-dels">-${totals.dels}</span>`
            : '';
        const cut = _totalChanged > files.length && !pausedNow() ? ` Showing ${files.length.toLocaleString('en-US')} of ${_totalChanged.toLocaleString('en-US')} changed files` : '';
        const html = `<span class="changed-files-count">${cut ? escapeHtml(cut.trim()) : `${files.length} file${files.length !== 1 ? 's' : ''} changed`}</span>
            ${stats}
            ${modeSelect}${compareNote}`;
        // The list is redrawn on every poll: the header is written only when it says something new, so its select and counts are not replaced under a person's pointer or a layout pass (#7671).
        if (titleEl._html !== html) {
            const sel = titleEl.querySelector('.diff-mode-select');
            if (sel && titleEl._select === options) { // only the count, the stats, the note or the select's hover words changed: they are rewritten around the select, which stays the same element (its focus, an open list, a Tab walk over it) (#11658)
                const frag = document.createElement('template'); frag.innerHTML = html;
                const fresh = frag.content.querySelector('.diff-mode-select'), before = [], after = []; let past = false;
                for (const n of frag.content.childNodes) { if (n === fresh) past = true; else (past ? after : before).push(n); }
                for (const n of [...titleEl.childNodes]) if (n !== sel) n.remove();
                sel.before(...before); sel.after(...after); sel.title = fresh.title;
            } else titleEl.innerHTML = html;
            titleEl._html = html; titleEl._select = options;
        }
    }
    if (countEl && !plain) {
        listCount(countEl, files.length > 0 ? String(files.length) : '');
    }

    if (files.length === 0) {
        // The comparison choice is in the header above, with the count: not drawn a second time under "No changed files" (#5991).
        list.innerHTML = staleNoteHtml() + (_filesRefused
            ? '<div class="empty-state empty-state-tight">Too many changed files to show through Coral Hub; open the agent on the computer.</div>'
            : `<div class="empty-state empty-state-tight">No changed files</div>`);
        return;
    }

    const starred = new Set(_getStarredFiles());
    const heldMore = list.contains(document.activeElement) && document.activeElement.classList.contains('file-more-btn') ? document.activeElement.dataset.path : ''; // the list is drawn again on every poll: the row's More button that had the keyboard gets it back (#7652)
    // What the colours mean, said once as the list's own first line, so the header keeps its height when the first file arrives (#10386, Beta; #10054)
    // The list is drawn again on every poll that moved it, and the reader is in the middle of it (#12520): the open diffs' slots (each holds its editor, with the unchanged-line blocks the person opened) are set aside and put back
    // into the new rows, and the scroll position is put back, so a refresh does not send them to the top or draw every open diff again from "Loading the changes…".
    const forAgent = `${state.currentSession ? state.currentSession.name + '|' + (state.currentSession.session_id || '') : ''}`, sameAgent = forAgent === _drawnFor; _drawnFor = forAgent; // a diff drawn for one agent is never put under another's row of the same name (#12570)
    const kept = new Map(); if (sameAgent) for (const slot of list.querySelectorAll('.file-diff')) if (!slot.hidden && slot.firstChild && _expandedFiles.has(slot.dataset.filepath)) kept.set(slot.dataset.filepath, slot);
    const scroller = scrollerOf(list), scrolled = scroller ? scroller.scrollTop : 0;
    let anchor = null; // the file under the top of the view and how far its row is from that top: a file that arrives above it moves the list, not the reader's place
    if (scroller) { const top = scroller.getBoundingClientRect().top; for (const row of list.querySelectorAll('.file-item')) { const slot = row.nextElementSibling, end = (slot && slot.classList.contains('file-diff') && !slot.hidden ? slot : row).getBoundingClientRect().bottom; if (end > top) { anchor = { path: row.dataset.filepath, at: row.getBoundingClientRect().top - top }; break; } } }
    const rowsHtml = files.map((f, i) => {
        const { dir, name } = splitPath(f.filepath);
        const statusCls = getStatusClass(f.status);
        const statusLabel = getStatusLabel(f.status);
        const adds = f.additions > 0 ? `<span class="file-adds">+${f.additions}</span>` : '';
        const dels = f.deletions > 0 ? `<span class="file-dels">-${f.deletions}</span>` : '';
        const stats = (adds || dels) ? `<span class="file-stats">${adds}${dels}</span>` : '';
        const isStarred = starred.has(f.filepath);
        const isAgentOnly = f.status === 'agent_only';
        const agentOnlyCls = isAgentOnly ? ' file-agent-only' : '';
        const agentsHtml = f.agents && f.agents.length > 0
            ? `<span class="file-agents">${escapeHtml(f.agents.map(a => a.name).join(', '))}</span>`
            : '';
        const rowName = splitPath(f.filepath).name;
        const rowTitle = plain ? f.filepath : `${f.filepath} (${statusLabel})`;
        const starLabel = `${isStarred ? 'Unstar' : 'Star'} ${rowName}`, copyLabel = `Copy path of ${rowName}`, previewLabel = `Preview ${rowName}`, editLabel = `Edit ${rowName}`;
        const starBtn = `<button class="btn btn-quiet btn-icon btn-xs file-star-btn ${escapeAttr(isStarred ? 'starred' : '')}" data-filepath="${escapeAttr(f.filepath)}" data-on-click="file-star" data-path="${escapeAttr(f.filepath)}" title="${escapeAttr(isStarred ? 'Unstar' : 'Star')}" aria-label="${escapeAttr(starLabel)}">${isStarred ? '★' : '☆'}</button>`;
        const copyBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-copy" data-path="${escapeAttr(f.filepath)}" title="Copy path" aria-label="${escapeAttr(copyLabel)}"><span class="material-icons" aria-hidden="true">content_copy</span></button>`;
        const previewBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-preview" data-path="${escapeAttr(f.filepath)}" ${plain ? '' : 'data-diff="1"'} title="Preview" aria-label="${escapeAttr(previewLabel)}"><span class="material-icons" aria-hidden="true">visibility</span></button>`;
        const editBtn = `<button class="btn btn-quiet btn-icon btn-xs file-action-btn" data-on-click="file-edit" data-path="${escapeAttr(f.filepath)}" ${plain ? '' : 'data-diff="1"'} title="Edit" aria-label="${escapeAttr(editLabel)}"><span class="material-icons" aria-hidden="true">edit</span></button>`;
        const shareBtn = shareButton(f.filepath, rowName);
        const open = !plain && _expandedFiles.has(f.filepath);
        const expandTitle = `${open ? 'Hide' : 'Show'} the changes`, expandLabel = `${expandTitle} in ${rowName}`;
        const expandBtn = plain ? '' : `<button type="button" class="btn btn-quiet btn-icon btn-xs file-expand-btn" data-on-click="file-expand" data-path="${escapeAttr(f.filepath)}" aria-expanded="${escapeAttr(String(open))}" aria-controls="file-diff-${Number(i)}" title="${escapeAttr(expandTitle)}" aria-label="${escapeAttr(expandLabel)}"><span class="material-icons" aria-hidden="true">${open ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</span></button>`;
        const diffSlot = plain ? '' : `<div class="file-diff" id="file-diff-${Number(i)}" data-filepath="${escapeAttr(f.filepath)}"${open ? '' : ' hidden'}></div>`;

        // Clicking the row opens its diff in the preview pane; the buttons
        // copy the path, preview the file, and open it in the editor.
        return `<div class="file-item ${statusCls}${agentOnlyCls}${escapeAttr(_actionsOpenFor === f.filepath ? ' actions-open' : '')}" title="${escapeAttr(rowTitle)}"
                     data-filepath="${escapeAttr(f.filepath)}"
                     data-on-click="file-open" data-path="${escapeAttr(f.filepath)}" ${plain ? '' : 'data-diff="1"'}>
            ${expandBtn}${starBtn}
            <span class="file-type-icon">${fileIconHtml(name)}</span>
            <div class="file-path-wrap">
                <span class="file-name">${escapeHtml(name)}</span>
                ${dir ? `<span class="file-dir">${escapeHtml(dir)}</span>` : ''}
                ${agentsHtml}
            </div>
            ${stats}
            ${moreButton(f.filepath, rowName)}
            <div class="file-action-btns">${copyBtn}${previewBtn}${editBtn}${shareBtn}</div>
        </div>${diffSlot}`;
    }).join('');
    const allOpen = !plain && files.every(f => _expandedFiles.has(f.filepath)), expandAllText = allOpen ? 'Collapse all' : 'Expand all', expandAllLabel = `${expandAllText} the changes`;
    // Expand all (#11350) is on the list's first line, not in the header: the header keeps its size when the first list arrives (#7671).
    const expandAll = plain ? '' : `<button type="button" class="btn btn-quiet btn-xs files-expand-all" data-on-click="files-expand-all" aria-label="${escapeAttr(expandAllLabel)}">${escapeHtml(expandAllText)}</button>`;
    // Reusing unchanged rows avoids tearing down thousands of layout objects when an async read lands during typing (#13666).
    const replaceEditors = !sameAgent && !!list.querySelector('.file-diff:not([hidden])');
    const listHtml = `${staleNoteHtml()}<div class="files-legend"><span>New files are green, deleted ones red, the rest changed.</span>${expandAll}</div>${rowsHtml}`;
    if (replaceEditors) list.innerHTML = listHtml; // another agent gets fresh editor slots and their state
    else morphHtml(list, listHtml);
    for (const fresh of list.querySelectorAll('.file-diff')) { const old = kept.get(fresh.dataset.filepath); if (old && old !== fresh && !fresh.hidden) { old.id = fresh.id; fresh.replaceWith(old); if (old.querySelector('.diff-comments')) importOnce('./diff_comments.js').then(m => m.placeDiffCommentIcon(old)).catch(() => {}); /* its comment icon goes back in the new row (#13528) */ } }
    if (scroller && scrolled) {
        scroller.scrollTop = scrolled;
        const row = anchor && [...list.querySelectorAll('.file-item')].find(r => r.dataset.filepath === anchor.path);
        if (row) scroller.scrollTop += (row.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - anchor.at;
    }
    if (heldMore) [...list.querySelectorAll('.file-more-btn')].find(b => b.dataset.path === heldMore)?.focus({ preventScroll: true });
    paintExpandAll();
    if (!plain && _expandedFiles.size) showExpanded(list, files); // the diffs that were open are drawn again from what was read (#11350)
}

// The changed and starred files' markup (#3645): data-on-* names, never code. The path is the file's
// own (data-path, never re-escaped into a script); data-diff opens its diff.
const pathOf = el => textOf(el.dataset.path, 4096);
const diffOpts = el => (el.dataset.diff === '1' ? [0, { diff: true }] : []);
registerActions({
    'file-expand': (el, event) => { event.stopPropagation(); toggleFileExpanded(pathOf(el)); },
    'files-expand-all': () => toggleAllExpanded(),
    'worktree-launch': () => switchWorktree('launch'),
    'worktree-follow': () => switchWorktree('follow'),
    'file-open': el => { const p = pathOf(el); if (p) openFilePreview(p, ...diffOpts(el)); },
    'file-star': (el, event) => { event.stopPropagation(); const p = pathOf(el); if (p) toggleStarFile(p); },
    'file-more': (el, event) => { event.stopPropagation(); const p = pathOf(el); if (!p) return; _actionsOpenFor = _actionsOpenFor === p ? '' : p; const row = el.closest('.file-item'); if (row) row.classList.toggle('actions-open', _actionsOpenFor === p); el.setAttribute('aria-expanded', String(_actionsOpenFor === p)); },
    'file-copy': (el, event) => { event.stopPropagation(); const p = pathOf(el); if (p) copyFilePath(p); },
    'file-preview': (el, event) => { event.stopPropagation(); const p = pathOf(el); if (p) openFilePreview(p, ...diffOpts(el)); },
    'file-share': async (el, event) => { event.stopPropagation(); const p = pathOf(el); if (p) (await importOnce('./share_file.js')).shareFileAsArtifact(p); },
    'file-edit': (el, event) => { event.stopPropagation(); const p = pathOf(el); if (p) openFileEdit(p, ...diffOpts(el)); },
    // On mousedown, as before: the @-mention list closes on the input's blur, which a click comes after.
    // Only a mode this list offers.
    'diff-mode': el => { if (_diffModes.includes(el.value)) setGitDiffMode(el.value); },
});
