/* Preview placement, resizing, maximising, and phone focus restoration. */
import { isPhoneLayout } from './phone_layout.js';
import { makeDraggable } from './draggable.js';
import { fitTerminal } from './xterm_renderer.js';
import { trapTab } from './dialog_focus.js';
import { pushOverlay, popOverlay } from './overlay_history.js';
import { browserLocal } from './safe_storage.js';

export function createPreviewLayout({ getTabs, isTaskPreview, getLastOpenedPath, _onToolbarClick }) {

    let _paneHeight = null;
    let _paneWidth = null;
    let _dock = 'bottom';      // 'bottom' (under the side panel tabs) | 'column' (full-height column)
    let _phoneFull = false;     // a phone's preview covers the screen (#5173); not saved
    let _fullOverlay = 0;       // its entry in overlay_history.js, while it is open
    let _fullOpener = null;     // what had focus when it opened
    let _fullOpenerPath = ''; // the file row to restore when the original opener was redrawn (#7652)
    const _pathOf = el => (el && el.closest && el.closest('[data-path]') ? el.closest('[data-path]').dataset.path : '') || '';
    const _rowFor = p => (p ? document.querySelector(`.file-more-btn[data-path="${CSS.escape(p)}"]`) || document.querySelector(`[data-path="${CSS.escape(p)}"][tabindex]`) : null);
    let _restoreBottom = false; // expanding a dock task returns to its sidebar split on restore
    let _maximised = false;    // the column covers Chat (#4931): not saved (a reload opens with Chat); ends when the pane is hidden, moves to the bottom, or another agent is shown

    const DOCK_ICONS = {
        // Shown while docked at the bottom: switch to a full-height column.
        bottom: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/></svg>',
        // Shown while docked as a column: switch back to the bottom.
        column: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 9h13"/></svg>',
    };

    // A maximised preview shows these in the tab bar (a toggle, #4931): maximise = the pane takes the whole centre, Chat hidden behind it; restore = the old split.
    const MAX_ICON_OFF = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5 7 9"/></svg>';
    const MAX_ICON_ON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4"/></svg>';

    // The column's width (#4931). What is saved is the person's wish; what is shown is that wish held to what the window has room for, every time it is placed, so a width saved in a big window, a
    // corrupted value or a narrow window can never leave a pane that cannot be seen or dragged: at least COLUMN_MIN wide, and Chat keeps at least CHAT_MIN. (The side panel is outside .live-body.)
    const COLUMN_MIN = 240, COLUMN_DEFAULT = 480, CHAT_MIN = 240, HANDLE_W = 1;
    function _maxColumnWidth() {
        const body = document.querySelector('.live-body');
        const room = body ? body.getBoundingClientRect().width : window.innerWidth;
        return Math.max(COLUMN_MIN, Math.floor(room - CHAT_MIN - HANDLE_W));
    }
    function _clampColumnWidth(w) {
        w = Number(w);
        if (!Number.isFinite(w) || w <= 0) w = COLUMN_DEFAULT;
        return Math.round(Math.min(Math.max(w, COLUMN_MIN), _maxColumnWidth()));
    }
    function _clampPaneHeight(h) {
        h = Number(h);
        const side = document.getElementById('agentic-state');
        const max = Math.max(100, Math.floor((side ? side.getBoundingClientRect().height : window.innerHeight) * 0.7));
        if (!Number.isFinite(h) || h <= 0) return null;
        return Math.round(Math.min(Math.max(h, 100), max));
    }
    const _savedNumber = key => { const n = parseInt(browserLocal.get(key), 10); return Number.isFinite(n) && n > 0 ? n : null; };

    const _isMobile = () => isPhoneLayout();
    const _effectiveDock = () => (_isMobile() ? 'bottom' : _dock);

    function initPreviewPane() {
        const handle = document.getElementById('preview-pane-resize-handle');
        if (!handle) return;

        _paneHeight = _savedNumber('coral-preview-pane-height');

        makeDraggable(handle, {
            cursor: 'row-resize',
            onMove: (e) => {
                const container = document.getElementById('agentic-state');
                if (!container) return null;
                const rect = container.getBoundingClientRect();
                const newHeight = rect.bottom - e.clientY;
                const min = 100;
                const max = rect.height * 0.7;
                return Math.min(Math.max(newHeight, min), max);
            },
            onFlush: (v) => {
                const pane = document.getElementById('preview-pane');
                if (pane) pane.style.height = v + 'px';
            },
            onEnd: (v) => {
                if (v != null) {
                    _paneHeight = Math.round(v);
                    browserLocal.set('coral-preview-pane-height', _paneHeight);
                }
            },
        });

        _paneWidth = _savedNumber('coral-preview-column-width');
        if (browserLocal.get('coral-preview-pane-dock') === 'column') _dock = 'column';

        const colHandle = document.getElementById('preview-column-resize-handle');
        const column = document.getElementById('preview-column');
        const liveBody = document.querySelector('.live-body');
        if (colHandle && column && liveBody) {
            makeDraggable(colHandle, {
                cursor: 'col-resize',
                onMove: (e) => {
                    // The room is .live-body's: the side panel is outside it (it was taken off again here, so the limit fell to the minimum and the pane could only be dragged narrower, #4931).
                    return Math.min(Math.max(column.getBoundingClientRect().right - e.clientX, COLUMN_MIN), _maxColumnWidth());
                },
                onFlush: (v) => { column.style.width = v + 'px'; _syncColumnHandle(v); },
                onEnd: (v) => {
                    if (v != null) {
                        _paneWidth = Math.round(v);
                        browserLocal.set('coral-preview-column-width', _paneWidth);
                    }
                },
            });
            // The handle by keyboard (a separator with a value): Left widens, Right narrows, Home and End go to the ends; kept where the window has room.
            colHandle.addEventListener('keydown', (e) => {
                const step = e.shiftKey ? 96 : 24;
                const now = column.getBoundingClientRect().width;
                const next = e.key === 'ArrowLeft' ? now + step : e.key === 'ArrowRight' ? now - step : e.key === 'Home' ? COLUMN_MIN : e.key === 'End' ? _maxColumnWidth() : null;
                if (next === null) return;
                e.preventDefault();
                _paneWidth = _clampColumnWidth(next);
                browserLocal.set('coral-preview-column-width', _paneWidth);
                _applyColumnWidth();
                fitTerminal();
            });
            // The room changes with the window, the side panel opening or shutting, and the sidebar's width: the width shown is held to it again each time.
            if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (getTabs().length && _effectiveDock() === 'column' && !_maximised) _applyColumnWidth(); }).observe(liveBody);
        }

        document.getElementById('preview-max-btn')?.addEventListener('click', () => (_isMobile() ? _setPhoneFull(!_phoneFull) : _setMaximised(!_maximised)));
        document.getElementById('preview-full-back')?.addEventListener('click', () => _setPhoneFull(false));
        // Escape gives the maximised pane back its place, unless something in it (the editor's own search box) already used the key.
        document.addEventListener('keydown', (e) => {
            if (_phoneFull && e.key === 'Tab' && !e.defaultPrevented) { trapTab(document.getElementById('preview-pane'), e); return; } // focus stays inside the full-screen preview
            if (e.key !== 'Escape' || !(_maximised || _phoneFull) || e.defaultPrevented) return;
            if ([...document.querySelectorAll('.modal')].some(m => m.style.display && m.style.display !== 'none')) return; // a dialog has the key
            if (_phoneFull) _setPhoneFull(false); else _setMaximised(false);
            e.preventDefault();
            document.getElementById('preview-max-btn')?.focus();
        });

        document.getElementById('preview-dock-btn')?.addEventListener('click', () => {
            _restoreBottom = false;
            _dock = _dock === 'column' ? 'bottom' : 'column';
            browserLocal.set('coral-preview-pane-dock', _dock);
            _placePane();
        });
        window.addEventListener('resize', () => { if (getTabs().length) _placePane(); });
        _placePane();
        _setMaximised(false); // paints the toggle's icon and label

        // Toolbar buttons are re-rendered per tab, so listen on the container.
        document.getElementById('preview-toolbar')?.addEventListener('click', _onToolbarClick);
    }

    /** Show the column at the width wished for, held to the room there is (the wish itself is kept for when the window grows back). */
    function _applyColumnWidth() {
        const column = document.getElementById('preview-column');
        if (!column) return;
        const w = _clampColumnWidth(_paneWidth);
        column.style.width = w + 'px';
        _syncColumnHandle(w);
    }

    function _syncColumnHandle(w) {
        const h = document.getElementById('preview-column-resize-handle');
        if (!h) return;
        h.setAttribute('aria-valuemin', String(COLUMN_MIN));
        h.setAttribute('aria-valuemax', String(_maxColumnWidth()));
        h.setAttribute('aria-valuenow', String(Math.round(w)));
    }

    /** Maximise the column over Chat, or give Chat its place back (#4931). The width the column had is untouched: restoring is taking one class off. */
    function _setMaximised(on) {
        if (on && !_isMobile() && _dock === 'bottom' && isTaskPreview() && getTabs().length) { _restoreBottom = true; _dock = 'column'; }
        on = !!on && _effectiveDock() === 'column' && getTabs().length > 0;
        const restore = !on && _restoreBottom;
        if (restore) { _restoreBottom = false; _dock = 'bottom'; }
        const body = document.querySelector('.live-body');
        const changed = on !== _maximised;
        _maximised = on;
        if (body) body.classList.toggle('preview-maximised', on);
        _placePane();
        _paintMaxButton();
        if (changed) fitTerminal(); // the chat or terminal got its room back or lost it
    }

    // The toggle in the tab bar: maximise over the chat (the column), or full screen (a phone).
    function _paintMaxButton() {
        const btn = document.getElementById('preview-max-btn');
        if (!btn) return;
        const phone = _isMobile(), on = phone ? _phoneFull : _maximised;
        btn.innerHTML = on ? MAX_ICON_ON : MAX_ICON_OFF;
        btn.title = phone ? (on ? 'Leave full screen (Escape)' : 'Show the preview full screen') : (on ? (_restoreBottom ? 'Restore the preview in the sidebar (Escape)' : 'Restore the preview beside the chat (Escape)') : 'Maximise the preview over the chat');
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(on));
    }

    /** A phone's preview takes the whole screen (#5173): the pane leaves the half of the side panel it sits in for a fixed layer over the page, with a Back button, and Escape or the
     *  browser's Back closes it. Nothing about the tabs changes, so closing it returns to the sheet as it was. */
    function _setPhoneFull(on, { popped = false } = {}) {
        on = !!on && _isMobile() && getTabs().length > 0;
        const pane = document.getElementById('preview-pane');
        const btn = document.getElementById('preview-max-btn');
        if (!pane || on === _phoneFull) return;
        _phoneFull = on;
        pane.classList.toggle('preview-phone-full', on);
        if (on) {
            pane.setAttribute('role', 'dialog'); pane.setAttribute('aria-modal', 'true'); pane.setAttribute('aria-label', 'Preview');
            _fullOpener = document.activeElement; _fullOpenerPath = _pathOf(_fullOpener) || getLastOpenedPath();
            _fullOverlay = pushOverlay(() => _setPhoneFull(false, { popped: true })); // Back closes it, in its order among the overlays (overlay_history.js)
        } else {
            pane.removeAttribute('role'); pane.removeAttribute('aria-modal'); pane.removeAttribute('aria-label');
            if (_fullOverlay) { const id = _fullOverlay; _fullOverlay = 0; if (!popped) popOverlay(id); }
        }
        _paintMaxButton();
        if (on) document.getElementById('preview-full-back')?.focus();
        else { const o = _fullOpener, back = o && o.isConnected && o !== document.body ? o : _rowFor(_fullOpenerPath); _fullOpener = null; _fullOpenerPath = ''; if (back) back.focus({ preventScroll: true }); }
    }

    /** Move the pane between the side panel (bottom) and its own column, then show it if it has tabs. */
    function _placePane() {
        const pane = document.getElementById('preview-pane');
        const bottomHandle = document.getElementById('preview-pane-resize-handle');
        const column = document.getElementById('preview-column');
        const colHandle = document.getElementById('preview-column-resize-handle');
        const side = document.getElementById('agentic-state');
        if (!pane || !bottomHandle || !column || !colHandle || !side) return;

        const dock = _effectiveDock();
        const visible = getTabs().length > 0;
        if (dock === 'column') {
            if (pane.parentElement !== column) column.appendChild(pane);
            pane.classList.add('docked-column');
            pane.style.height = '';
        } else {
            if (pane.parentElement !== side) side.appendChild(pane);
            pane.classList.remove('docked-column');
            const h = _clampPaneHeight(_paneHeight);
            if (h) pane.style.height = h + 'px';
        }
        column.style.display = dock === 'column' && visible ? '' : 'none';
        colHandle.style.display = dock === 'column' && visible ? '' : 'none';
        bottomHandle.style.display = dock === 'bottom' && visible ? '' : 'none';
        pane.style.display = visible ? '' : 'none';
        if (dock === 'column' && visible) _applyColumnWidth();
        // Maximise is the column's: nothing to cover at the bottom, on a phone (the pane is full screen there) or with no tabs.
        if (_maximised && !(dock === 'column' && visible)) _setMaximised(false);
        if (_phoneFull && !(_isMobile() && visible)) _setPhoneFull(false); // the last tab closed, or the window grew past a phone
        const maxBtn = document.getElementById('preview-max-btn');
        if (maxBtn) { maxBtn.hidden = _isMobile() ? !visible : !(visible && (dock === 'column' || isTaskPreview())); _paintMaxButton(); }

        const btn = document.getElementById('preview-dock-btn');
        if (btn) {
            btn.innerHTML = DOCK_ICONS[dock];
            btn.title = dock === 'column' ? 'Dock preview at the bottom of the side panel' : 'Dock preview as a full-height column';
            btn.setAttribute('aria-label', btn.title);
        }
    }

    function _showPane() {
        if (_effectiveDock() === 'bottom') {
            const agenticState = document.getElementById('agentic-state');
            if (agenticState && agenticState.classList.contains('collapsed')) {
                agenticState.classList.remove('collapsed');
                document.getElementById('agentic-collapse-btn')?.classList.remove('collapsed');
            }
            if (_isMobile()) window.toggleAgenticPanel?.(true);
        }
        _placePane();
    }
    function showBottom() {
        _setMaximised(false);
        _dock = 'bottom';
        if (!_isMobile()) _paneHeight = Math.round((document.getElementById('agentic-state')?.getBoundingClientRect().height || window.innerHeight) / 2);
        _placePane();
    }
    return { showBottom, initPreviewPane, _setMaximised, _setPhoneFull, _placePane, _showPane, _isMobile };
}
