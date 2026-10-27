/* Sidebar drag-to-resize functionality */

import { isPhoneLayout } from './phone_layout.js';
import { fitTerminal } from './xterm_renderer.js';
import { makeDraggable } from './draggable.js';
import { DOCK_MIN_WIDTH, dockMaxWidth } from './dock_resize.js';
import { browserLocal } from './safe_storage.js';
import { dockKey, dockOpenByDefault, onDockPage } from './dock_page.js';
import { machineState } from './launch_server.js';
import { setText, setAttr, setHidden, setTitle, setData } from './dom_write.js';

export function initSidebarResize() {
    const handle = document.getElementById("sidebar-resize-handle");
    const sidebar = document.querySelector(".sidebar");

    const saved = browserLocal.get('coral-sidebar-width');
    if (saved) {
        const w = parseInt(saved, 10);
        if (w >= 200 && w <= window.innerWidth * 0.5) sidebar.style.width = w + "px";
    }

    makeDraggable(handle, {
        cursor: 'col-resize',
        onMove: (e) => Math.min(Math.max(e.clientX, 200), window.innerWidth * 0.5),
        onFlush: (v) => { sidebar.style.width = v + "px"; },
        onEnd: () => { browserLocal.set('coral-sidebar-width', sidebar.offsetWidth); },
    });
}

/* Task bar drag-to-resize functionality */

const AGENTIC_MIN_WIDTH = DOCK_MIN_WIDTH;
const maxAgenticWidth = dockMaxWidth; // the limits are shared with a goal page's task column (dock_resize.js)

export function initTaskBarResize() {
    const handle = document.getElementById("task-bar-resize-handle");
    const taskBar = document.getElementById("agentic-state");
    const liveBody = document.querySelector(".main-row"); // the row the views and the sidebar share (#4539)

    if (!handle || !taskBar || !liveBody) return;

    applyDockWidth();

    makeDraggable(handle, {
        cursor: 'col-resize',
        onMove: (e) => {
            const rect = liveBody.getBoundingClientRect();
            const newWidth = rect.right - e.clientX;
            return Math.min(Math.max(newWidth, AGENTIC_MIN_WIDTH), maxAgenticWidth(liveBody));
        },
        onFlush: (v) => { taskBar.style.width = v + "px"; },
        onEnd: (v) => {
            if (v != null) browserLocal.set(dockKey('coral-taskbar-width'), Math.round(v));
        },
    });
}

/** The width this kind of page last had (the CSS width when it has none). */
function applyDockWidth() {
    const taskBar = document.getElementById("agentic-state");
    if (!taskBar) return;
    const saved = browserLocal.get(dockKey('coral-taskbar-width'));
    const w = saved ? parseInt(saved, 10) : 0;
    taskBar.style.width = w >= AGENTIC_MIN_WIDTH ? Math.min(w, maxAgenticWidth(document.querySelector(".main-row"))) + "px" : '';
}

/* Agentic block resize (top/bottom split) */

export function initAgenticBlockResize() {
    const handle = document.getElementById('agentic-block-resize-handle');
    const topBlock = document.getElementById('agentic-block-top');
    const bottomBlock = document.getElementById('agentic-block-bottom');
    const container = document.getElementById('agentic-state');

    if (!handle || !topBlock || !bottomBlock || !container) return;

    // Restore saved ratio
    const saved = browserLocal.get('coral-block-ratio');
    if (saved) {
        const ratio = parseFloat(saved);
        if (ratio > 0 && ratio < 1) {
            topBlock.style.flex = ratio.toString();
            bottomBlock.style.flex = (1 - ratio).toString();
        }
    }

    makeDraggable(handle, {
        cursor: 'row-resize',
        canDrag: () => !topBlock.classList.contains('collapsed') && !bottomBlock.classList.contains('collapsed'),
        onMove: (e) => {
            const rect = container.getBoundingClientRect();
            const topTabs = topBlock.querySelector('.agentic-state-tabs');
            const bottomTabs = bottomBlock.querySelector('.agentic-state-tabs');
            const tabsHeight = (topTabs ? topTabs.offsetHeight : 0) + (bottomTabs ? bottomTabs.offsetHeight : 0) + handle.offsetHeight;
            const available = rect.height - tabsHeight;
            const topTabsH = topTabs ? topTabs.offsetHeight : 0;
            const topPanelHeight = e.clientY - rect.top - topTabsH;
            const minPanel = 40;
            return Math.max(minPanel, Math.min(topPanelHeight, available - minPanel)) / available;
        },
        onFlush: (ratio) => {
            topBlock.style.flex = ratio.toString();
            bottomBlock.style.flex = (1 - ratio).toString();
        },
        onEnd: (ratio) => {
            if (ratio != null) browserLocal.set('coral-block-ratio', ratio.toFixed(3));
        },
    });
}

/* Collapsible sidebar sections */

const STORAGE_KEY = 'coral-sidebar-collapsed';

function getCollapsedState() {
    try {
        return JSON.parse(browserLocal.get(STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

function saveCollapsedState(state) {
    browserLocal.set(STORAGE_KEY, JSON.stringify(state));
}

export function initSidebarCollapse() {
    const sections = document.querySelectorAll('.sidebar-section[data-section]');
    const saved = getCollapsedState();

    for (const section of sections) {
        const sectionId = section.dataset.section;
        const header = section.querySelector('[data-collapse-toggle]');
        if (!header) continue;

        // Restore saved state
        if (saved[sectionId]) {
            section.classList.add('collapsed');
            section.dataset.manualCollapse = 'true';
        }

        header.addEventListener('click', (e) => {
            // Don't toggle if clicking a button inside the header
            if (e.target.closest('button')) return;

            const isCollapsed = section.classList.toggle('collapsed');
            section.dataset.manualCollapse = isCollapsed ? 'true' : '';
            if (!isCollapsed) {
                section.dataset.manualExpand = 'true';
            } else {
                delete section.dataset.manualExpand;
            }

            const state = getCollapsedState();
            state[sectionId] = isCollapsed;
            saveCollapsedState(state);
        });

        // Add aria-expanded
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', !section.classList.contains('collapsed'));
    }
}

export function updateSectionVisibility(sectionId, itemCount) {
    const section = document.querySelector(`[data-section="${sectionId}"]`);
    if (!section) return;

    const badge = section.querySelector('.section-count-badge');
    if (badge) setText(badge, String(itemCount));

    // Update aria-expanded
    const header = section.querySelector('[data-collapse-toggle]');
    if (header) {
        setAttr(header, 'aria-expanded', !section.classList.contains('collapsed'));
    }

    // Keep History available when a search/filter has no matches. Collapsing the
    // section would also hide the controls needed to change or clear the filter.
    // On Coral Hub with no machine connected the empty list carries the way forward (Connect a machine): it stays open (#4586).
    const canAutoCollapseWhenEmpty = sectionId !== 'history' && !(sectionId === 'live-sessions' && ['none', 'offline'].includes(machineState()));

    // Auto-collapse empty sections (unless user manually expanded)
    if (itemCount === 0 && canAutoCollapseWhenEmpty && !section.dataset.manualExpand) {
        if (!section.classList.contains('collapsed')) section.classList.add('collapsed'); // (a class write to the class it has is still a mutation)
    } else if ((itemCount > 0 || !canAutoCollapseWhenEmpty) && !section.dataset.manualCollapse) {
        if (section.classList.contains('collapsed')) section.classList.remove('collapsed');
    }
}

/* Jobs subtab switching */

/* Agentic block collapse (double-click tab bar) */

export function initAgenticBlockCollapse() {
    const blocks = document.querySelectorAll('.agentic-block');

    // Clear any stale collapsed state from localStorage — the hidden
    // double-click-to-collapse behavior confused users into permanently
    // hiding the panel with no obvious way to restore it.
    browserLocal.remove('coral-block-collapsed');

    for (const block of blocks) {
        const tabs = block.querySelector('.agentic-state-tabs');
        if (!tabs) continue;

        tabs.addEventListener('dblclick', (e) => {
            // Don't toggle if clicking a specific tab button
            if (e.target.closest('.agentic-tab')) return;
            // Toggle collapsed state (session-only, not persisted)
            block.classList.toggle('collapsed');
        });
    }
}

/* Agentic state panel collapse */

export function initAgenticPanelCollapse() {
    const panel = document.getElementById('agentic-state');
    if (!panel) return;

    // Open or closed as this kind of page last had it (the agent page and a board open at first)
    applyDockCollapsed();

    // Keep the old collapse button working too
    const btn = document.getElementById('agentic-collapse-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            const isCollapsed = panel.classList.toggle('collapsed');
            browserLocal.set(dockKey('coral-agentic-collapsed'), isCollapsed);
            _syncPanelToggleBtn(!isCollapsed);
            fitTerminal();
        });
    }
}

/** Open or closed as the page on screen last had it. */
function applyDockCollapsed() {
    const panel = document.getElementById('agentic-state');
    if (!panel) return;
    const stored = browserLocal.get(dockKey('coral-agentic-collapsed'));
    const collapsed = stored === null ? !dockOpenByDefault() : stored === 'true';
    panel.classList.toggle('collapsed', collapsed);
    _syncPanelToggleBtn(!collapsed);
}

// Each kind of page keeps its own open state and width (#4539): a page change restores them. A phone's overlay is not a page's state.
onDockPage(kind => {
    const panel = document.getElementById('agentic-state');
    if (panel) panel.style.transition = 'none'; // a page's own state appears at once, it does not slide in from the last page's
    applyDockWidth();
    applyDockCollapsed();
    if (panel) { void panel.offsetWidth; requestAnimationFrame(() => { panel.style.transition = ''; }); }
    if (kind === 'agent') requestAnimationFrame(() => fitTerminal?.());
});

export function toggleAgenticPanel(forceState) {
    const panel = document.getElementById('agentic-state');
    if (!panel) return;
    if (isPhoneLayout()) {
        let isOverlay;
        if (typeof forceState === 'boolean') {
            isOverlay = forceState;
            panel.classList.toggle('mobile-panel-overlay', isOverlay);
        } else {
            isOverlay = panel.classList.toggle('mobile-panel-overlay');
        }
        panel.classList.remove('collapsed');
        _syncPanelToggleBtn(isOverlay);
        if (isOverlay) {
            // Ensure an active panel is selected if none active
            const activePanel = panel.querySelector('.agentic-panel.active');
            if (!activePanel) {
                const filesTab = document.getElementById('agentic-tab-files');
                if (filesTab) filesTab.click();
            }
        }
        return;
    }
    const isCollapsed = typeof forceState === 'boolean' ? !forceState : panel.classList.toggle('collapsed');
    if (typeof forceState === 'boolean') {
        panel.classList.toggle('collapsed', isCollapsed);
    }
    browserLocal.set(dockKey('coral-agentic-collapsed'), isCollapsed);
    _syncPanelToggleBtn(!isCollapsed);
    // Opened on the Saved tab: its list is read now (the tab's switch skips a shut sidebar, agentic_state.js)
    if (!isCollapsed && panel.querySelector('#agentic-block-top .agentic-tab.active')?.dataset.tab === 'saved') window.switchAgenticTab?.('saved', 'top');
    // Fit terminal immediately and again after CSS transition completes
    fitTerminal();
    setTimeout(() => fitTerminal(), 50);
    setTimeout(() => fitTerminal(), 300);
}

 function _syncPanelToggleBtn(isOpen) {
    document.body.setAttribute('data-dock-open', isOpen ? '1' : '0'); // for the page's own layout (the board's toolbar makes room when the sidebar is open)
    const btn = document.getElementById('panel-toggle-btn');
    if (btn) { btn.classList.toggle('active', isOpen); btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false'); }
    document.dispatchEvent(new CustomEvent('coral:dock-changed')); // the Saved button's pressed state follows (saved_marks.js, #4742)
    const popoutBtn = document.getElementById('popout-panel-toggle-btn');
    if (popoutBtn) {
        popoutBtn.classList.toggle('active', isOpen);
        popoutBtn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
        popoutBtn.setAttribute('aria-label', isOpen ? 'Hide side panel' : 'Show side panel');
        popoutBtn.title = popoutBtn.getAttribute('aria-label');
    }
}


/* The sidebar's panes (#7443): one pane per tab (header, list, pinned action), shown for the tab on screen. The header's parts and the 56 px rail are the same on every tab;
 * what differs is what the search is for, whether the tab has Display options and groups, and its one pinned action. Hide turns the column into the rail; the choice is the
 * tab's own, kept in this browser. */
const SIDEBAR_PANES = {
    agents: { search: 'Search agents', action: { name: 'launch-show', label: 'New agent' } },
    history: { search: 'Search chats', action: null },
    automations: { search: 'Search jobs', action: null }, // Workflows and Jobs as one screen (Goal #74): its folders' toolbars carry the create action
    'hub-inbox': { search: 'Search the Inbox', action: null },
    workflows: { search: 'Search workflows', action: { name: 'wf-create', label: 'New workflow' } },
    tokens: { search: 'Search views', action: null }, // Analytics: the tab's name is tokens
    docs: { search: 'Search docs', action: null },
};

const RAIL_KEY = 'coral-sidebar-collapsed-rail'; // the Agents tab's (its name from before the other tabs had one)
const railKey = pane => pane === 'agents' ? RAIL_KEY : `${RAIL_KEY}-${pane}`;
let currentPane = 'agents';

function applyRail(collapsed) {
    document.querySelector('.layout')?.classList.toggle('sidebar-collapsed', collapsed);
    // The terminal column changes width with the sidebar.
    requestAnimationFrame(() => fitTerminal?.());
}

function readRail(pane) {
    try { return browserLocal.get(railKey(pane)) === '1'; } catch { return false; /* storage unavailable */ }
}

/** Shows the pane of the tab that was opened (none for a tab that has no sidebar) and gives the rail that tab's search and action. */
export function showSidebarPane(tab) {
    const pane = SIDEBAR_PANES[tab] ? tab : null;
    currentPane = pane || currentPane;
    const layout = document.querySelector('.layout');
    for (const el of document.querySelectorAll('.sidebar-pane[data-pane]')) setHidden(el, el.dataset.pane !== pane);
    if (!pane || !layout) return;
    setData(layout, 'sidebarPane', pane);
    const cfg = SIDEBAR_PANES[pane];
    const search = document.getElementById('sidebar-rail-search');
    if (search) {
        setHidden(search, !cfg.search);
        if (cfg.search) { setTitle(search, cfg.search); setAttr(search, 'aria-label', cfg.search); }
    }
    const add = document.getElementById('sidebar-rail-new');
    if (add) {
        setHidden(add, !cfg.action);
        if (cfg.action) { setTitle(add, cfg.action.label); setAttr(add, 'aria-label', cfg.action.label); setAttr(add, 'data-on-click', cfg.action.name); }
    }
    const collapsed = readRail(pane);
    if (layout.classList.contains('sidebar-collapsed') !== collapsed) applyRail(collapsed);
}

export function toggleSidebarRail() {
    const collapsed = !document.querySelector('.layout')?.classList.contains('sidebar-collapsed');
    try { browserLocal.set(railKey(currentPane), collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
    applyRail(collapsed);
}

export function initSidebarRail() {
    if (readRail(currentPane)) applyRail(true);
}

/** The search of the pane on screen: opens the column first when it is the rail. */
export function focusSidebarSearch() {
    if (document.querySelector('.layout')?.classList.contains('sidebar-collapsed')) toggleSidebarRail();
    document.querySelector('.sidebar-pane:not([hidden]) .sidebar-search-input')?.focus();
}
