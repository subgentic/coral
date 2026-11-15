// The Files panel's search (#17632 moved it out of changed_files.js, which loads at start): a dropdown of the agent's files as you type, Enter opens one, and a path that is not there offers + Create.
import { state } from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { serverFetch, sessionServer } from './server_base.js';
import { fetchFileList, fuzzyFilter } from './file_mention.js';
import { openFilePreview, openFileEdit, refreshChangedFiles } from './changed_files.js';

let _searchTimeout = null;
let _renderTimer = null;



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
    _searchResults = files.slice(0, 50).map(path => ({ path, type: 'file' }));
    if (query && (query.includes('/') || query.includes('.')) && !files.includes(query)) _searchResults.push({ path: query, type: 'create' }); // +create option at the end
    if (!_searchResults.length) { _hideSearchDropdown(); return; }
    const at = _searchSelectedIdx;
    dropdown.innerHTML = _searchResults.map((r, i) => `<div class="file-mention-item${i === at ? ' selected' : ''}" data-index="${Number(i)}"${r.type === 'create' ? ' style="color:var(--accent)"' : ''}>${r.type === 'create' ? '+ Create ' : ''}${escapeHtml(r.path)}</div>`).join('');
    _searchSelectedIdx = Math.min(at, _searchResults.length - 1);
    dropdown.style.display = 'block';
    dropdown.querySelectorAll('.file-mention-item').forEach(el => el.addEventListener('mousedown', (e) => { e.preventDefault(); _selectSearchItem(parseInt(el.dataset.index)); }));
}

function _selectSearchItem(index) {
    if (index < 0 || index >= _searchResults.length) return;
    const item = _searchResults[index];

    if (item.type === 'create') {
        _hideSearchDropdown();
        createFile(item.path);
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

export function bindFileSearch(input) {

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

async function createFile(filePath) {
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
