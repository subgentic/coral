/* Mobile navigation and view management */

import { isPhoneLayout } from './phone_layout.js';
import { state } from './state.js';
import { syncDisplayMenu } from './session_rows.js';
import { showView } from './utils.js';
import { note, backIs } from './nav.js';
import { switchRow } from './switch_row.js';

function isMobile() {
    return isPhoneLayout(); // a narrow window, or a phone turned to landscape (phone_layout.js, #6683)
}

// ── Tablet Sidebar Toggle ─────────────────────────────────────────────────

function toggleTabletSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.querySelector('.tablet-sidebar-backdrop');
    if (!sidebar) return;

    const isOpen = sidebar.classList.toggle('tablet-open');
    if (backdrop) backdrop.classList.toggle('active', isOpen);
    document.querySelector('.tablet-sidebar-toggle')?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}
window.toggleTabletSidebar = toggleTabletSidebar;

// The sidebar is a complementary landmark named for the tab it shows (it said "Agents" on the Inbox, Automations, Analytics and Docs tabs, where it holds their folders), and a drawer that is shut (a narrow desktop window,
// 768 to 1023 px) is inert: off screen, it is not in the accessibility tree or the Tab order (#10306 LOW, #10452).
const TAB_NAMES = { agents: 'Agents', 'hub-inbox': 'Inbox', automations: 'Automations', tokens: 'Analytics', docs: 'Docs' };
function syncSidebarLandmark() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const tab = document.body.getAttribute('data-nav-tab') || 'agents';
    const button = document.getElementById('nav-tab-' + tab); // a tab not in the list is named by its own button, never by the name the last tab left
    const name = TAB_NAMES[tab] || (button && (button.dataset.label || button.textContent.trim())) || 'Sidebar';
    if (sidebar.getAttribute('aria-label') !== name) sidebar.setAttribute('aria-label', name);
    const drawer = typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px) and (max-width: 1023px)').matches;
    sidebar.inert = drawer && !sidebar.classList.contains('tablet-open');
}
if (typeof document.addEventListener === 'function') {
    const start = () => {
        syncSidebarLandmark();
        new MutationObserver(syncSidebarLandmark).observe(document.body, { attributes: true, attributeFilter: ['data-nav-tab'] });
        const sb = document.querySelector('.sidebar'); if (sb) new MutationObserver(syncSidebarLandmark).observe(sb, { attributes: true, attributeFilter: ['class'] });
        window.matchMedia?.('(min-width: 768px) and (max-width: 1023px)').addEventListener?.('change', syncSidebarLandmark);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}
// Escape closes the drawer (#10306), and the focus goes back to the button that opened it; a click outside is the backdrop's.
if (typeof document.addEventListener === 'function') document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || !document.querySelector('.sidebar.tablet-open')) return;
    if (e.target instanceof Element && e.target.closest('.xterm, input, textarea, select, [contenteditable="true"]')) return; // in a terminal Escape belongs to the CLI, and in a field to the field
    e.preventDefault(); toggleTabletSidebar(); document.querySelector('.tablet-sidebar-toggle')?.focus();
});

// ── Bottom Tab Bar Navigation ─────────────────────────────────────────────

function switchMobileTab(tab) {
    // Tab bar is hidden on mobile via CSS — don't override with inline styles

    // Update tab active states
    document.querySelectorAll('.mobile-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });

    const view = tab === 'board' ? 'messageboard-view'
        : tab === 'chat' && state.currentSession?.type === 'live' ? 'live-session-view'
        : 'mobile-agent-list';
    showView(view);
}
window.switchMobileTab = switchMobileTab;

// ── Mobile Back Navigation ────────────────────────────────────────────────

function mobileBack() {
    if (!isMobile()) return;

    // If panel overlay is currently open, close it first and return to chat
    const agenticState = document.getElementById('agentic-state');
    if (agenticState && agenticState.classList.contains('mobile-panel-overlay')) {
        if (window.toggleAgenticPanel) {
            window.toggleAgenticPanel(false);
        } else {
            agenticState.classList.remove('mobile-panel-overlay');
        }
        return;
    }

    showView('mobile-agent-list');

    // Hide panel overlay and panel tab
    if (agenticState) agenticState.classList.remove('mobile-panel-overlay');
    const panelTab = document.getElementById('mobile-tab-panel');
    if (panelTab) panelTab.style.display = 'none';

    document.querySelectorAll('.mobile-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === 'agents');
    });

    // The agent list is the Agents page (#3532): Back when that is the entry before, so the phone's
    // back button and the browser's agree; otherwise a new entry.
    if (backIs({ view: 'agents' })) history.back();
    else note({ view: 'agents' });
}
window.mobileBack = mobileBack;

// ── Sync Agent List to Mobile View ────────────────────────────────────────

// On a phone the agent list is built once, in the Agents page itself: the sidebar's own list element moves into #mobile-agent-list (and takes the id
// #mobile-session-list that the phone's styles use) instead of being cloned, so the page holds one copy of every row and no id twice (#4497). On a wide
// screen it moves back, as #live-sessions-list, to where the sidebar has it.
let _sidebarHome = null; // { parent, next }: where the list sits in the sidebar

function _listHeader(agentList) {
    let header = agentList.querySelector(':scope > .mobile-list-header');
    if (header) return header;
    header = document.createElement('div');
    header.className = 'mobile-list-header';
    header.innerHTML = `
            <h2 class="mobile-list-title">Agents</h2>
            <button class="btn btn-quiet btn-icon sidebar-collapse-btn" type="button" data-display-button data-on-click="display-panel-toggle" aria-expanded="false" aria-controls="mobile-display-panel" title="Display options" aria-label="Display options">
                <span class="material-icons" style="font-size:var(--icon-size)" aria-hidden="true">notes</span><span class="display-dot" data-display-badge hidden></span>
            </button>
            <button class="btn btn-quiet btn-icon sidebar-collapse-btn group-toggle-btn" type="button" data-group-toggle data-next="collapse" data-on-click="groups-toggle-all" title="Collapse all groups" aria-label="Collapse all groups" hidden>
                <svg class="group-toggle-collapse" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 9l5-5 5 5M7 15l5 5 5-5"/></svg>
                <svg class="group-toggle-expand" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg>
            </button>
            <button class="btn btn-small btn-primary" data-on-click="launch-show">New</button>
            <div class="mobile-search-row" id="mobile-search-row">
                <input type="search" class="field field-search sidebar-search-input mobile-search-input" placeholder="Search agents" autocomplete="off" aria-label="Search agents" data-on-input="agent-search-filter" data-on-keydown="agent-search-key">
            </div>
            <span class="sr-only" role="status" aria-live="polite" data-agent-list-live></span>
            <div class="list-display-panel" id="mobile-display-panel" data-display-panel role="group" aria-label="Display options" data-on-keydown="display-panel-key" hidden>
                <div class="agent-list-bar" id="mobile-agent-list-bar" hidden></div>
                <div class="list-display-options">
                    ${switchRow({ label: 'Show server', labelClass: 'list-display-option', labelAttrs: ' data-display-row="server" hidden', attrs: ' data-display-input="server" data-on-change="toggle-show-server"' })}
                    ${switchRow({ label: 'Group by server', labelClass: 'list-display-option', labelAttrs: ' data-display-row="group" hidden', attrs: ' data-display-input="group" data-on-change="toggle-group-by-server"' })}
                </div>
            </div>
        `;
    agentList.prepend(header);
    return header;
}

// The phone's Agents page has its own Search agents box under the list header's controls (#4624): the sidebar's search is not on the phone. It is the same search (filterLiveAgents,
// Enter and Escape as there); a wide screen's box takes over its text when the list goes back to the sidebar (restoreSidebarList).

export function syncMobileAgentList() {
    if (document.body.classList.contains('popout-mode')) return;
    if (!isMobile()) { restoreSidebarList(); return; }

    const agentList = document.getElementById('mobile-agent-list');
    if (!agentList || agentList.dataset.mode === 'history') return;

    _listHeader(agentList);
    const phoneBox = agentList.querySelector('#mobile-search-row input'), sideBox = document.getElementById('agent-search-input');
    if (phoneBox && sideBox && !phoneBox.value) phoneBox.value = sideBox.value; // a search typed on a wide screen is still in the box
    syncDisplayMenu();   // the phone's copy of the ≡ menu (#3991)

    const list = document.getElementById('live-sessions-list');
    if (list && list.parentElement !== agentList) {
        _sidebarHome = { parent: list.parentElement, next: list.nextSibling };
        list.id = 'mobile-session-list';
        agentList.appendChild(list); // the cloned items kept their data-on-* actions; the moved ones keep their listeners too
    }
}

/** Wide screen: the list goes back into the sidebar as #live-sessions-list, where it was. */
function restoreSidebarList() {
    const list = document.getElementById('mobile-session-list');
    if (!list || !_sidebarHome || !_sidebarHome.parent.isConnected) return;
    list.id = 'live-sessions-list';
    // The search the phone's box held carries over to the sidebar's own box.
    const phoneSearch = document.querySelector('#mobile-search-row input'), sideSearch = document.getElementById('agent-search-input');
    if (phoneSearch && sideSearch) sideSearch.value = phoneSearch.value;
    _sidebarHome.parent.insertBefore(list, _sidebarHome.next && _sidebarHome.next.parentNode === _sidebarHome.parent ? _sidebarHome.next : null);
    _sidebarHome = null;
}

// One History section: the phone Chats page owns it; wider screens use the sidebar.
// Moving it preserves search/filter listeners, current values, results and pagination.
let _historyHome = null;
function syncMobileHistoryList() {
    const section = document.querySelector('[data-pane="history"]'); // the pane: its header (search, Display options) goes with its list (#7443)
    const host = document.getElementById('mobile-history-list');
    if (!section || !host) return;
    if (isMobile()) {
        if (!_historyHome) _historyHome = { parent: section.parentElement, next: section.nextSibling };
        if (section.parentElement !== host) host.appendChild(section);
    } else if (_historyHome) {
        const { parent, next } = _historyHome;
        parent.insertBefore(section, next?.parentNode === parent ? next : null);
        _historyHome = null;
    }
}

// The Inbox's lists: the same move (#7472).
let _inboxHome = null;
function syncMobileInboxList() {
    const section = document.querySelector('[data-pane="hub-inbox"]');
    const host = document.getElementById('mobile-inbox-list');
    if (!section || !host) return;
    if (isMobile()) {
        if (!_inboxHome) _inboxHome = { parent: section.parentElement, next: section.nextSibling };
        if (section.parentElement !== host) host.appendChild(section);
    } else if (_inboxHome) {
        const { parent, next } = _inboxHome;
        parent.insertBefore(section, next?.parentNode === parent ? next : null);
        _inboxHome = null;
    }
}

// The Analytics views: the same move (#7473).
let _analyticsHome = null;
function syncMobileAnalyticsList() {
    const section = document.querySelector('[data-pane="tokens"]');
    const host = document.getElementById('mobile-analytics-list');
    if (!section || !host) return;
    if (isMobile()) {
        if (!_analyticsHome) _analyticsHome = { parent: section.parentElement, next: section.nextSibling };
        if (section.parentElement !== host) host.appendChild(section);
    } else if (_analyticsHome) {
        const { parent, next } = _analyticsHome;
        parent.insertBefore(section, next?.parentNode === parent ? next : null);
        _analyticsHome = null;
    }
}

// The Docs topics: the same move (#7443): on a phone the pane is the page's own list, a wide screen puts it back.
let _docsHome = null;
function syncMobileDocsList() {
    const section = document.querySelector('[data-pane="docs"]');
    const host = document.getElementById('mobile-docs-list');
    if (!section || !host) return;
    if (isMobile()) {
        if (!_docsHome) _docsHome = { parent: section.parentElement, next: section.nextSibling };
        if (section.parentElement !== host) host.appendChild(section);
    } else if (_docsHome) {
        const { parent, next } = _docsHome;
        parent.insertBefore(section, next?.parentNode === parent ? next : null);
        _docsHome = null;
    }
}

// ── Intercept Session Selection on Mobile ─────────────────────────────────

 function wrapSelectLiveSession() {
    const orig = window.selectLiveSession;
    if (!orig) return;

    window.selectLiveSession = function(name, agentType, sessionId, server) {
        // Call original with every argument it was given (its options too: Open chat's focusChat, a click's pointer, #9794)
        const selection = orig(...arguments);

        // On mobile, hide agent list to show full session view and reset panel overlay
        if (isMobile()) {
            const agentList = document.getElementById('mobile-agent-list');
            if (agentList) agentList.style.display = 'none';
            const agenticState = document.getElementById('agentic-state');
            if (agenticState) {
                agenticState.classList.remove('mobile-panel-overlay');
                if (window.toggleAgenticPanel) window.toggleAgenticPanel(false);
            }
        }

        // On tablet, close the sidebar overlay
        const sidebar = document.querySelector('.sidebar');
        const backdrop = document.querySelector('.tablet-sidebar-backdrop');
        if (sidebar) sidebar.classList.remove('tablet-open');
        if (backdrop) backdrop.classList.remove('active');
        document.querySelector('.tablet-sidebar-toggle')?.setAttribute('aria-expanded', 'false');
        return selection; // preserve the async team-exit/navigation contract for callers
    };
}

// ── Pull-to-Refresh ───────────────────────────────────────────────────────

function _initPullToRefresh() {
    const agentList = document.getElementById('mobile-agent-list');
    if (!agentList) return;

    let startY = 0;
    let pulling = false;
    let refreshIndicator = null;

    agentList.addEventListener('touchstart', (e) => {
        if (agentList.scrollTop === 0) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    agentList.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 10 && agentList.scrollTop === 0) {
            if (!refreshIndicator) {
                refreshIndicator = document.createElement('div');
                refreshIndicator.className = 'pull-refresh-indicator';
                refreshIndicator.textContent = 'Pull to refresh...';
                agentList.insertBefore(refreshIndicator, agentList.firstChild);
            }
            const progress = Math.min(dy / 80, 1);
            refreshIndicator.style.height = Math.min(dy * 0.5, 50) + 'px';
            refreshIndicator.style.opacity = progress;
            if (dy > 80) {
                refreshIndicator.textContent = 'Release to refresh';
            } else {
                refreshIndicator.textContent = 'Pull to refresh...';
            }
        }
    }, { passive: true });

    agentList.addEventListener('touchend', (e) => {
        if (!pulling) return;
        pulling = false;
        const dy = (e.changedTouches[0]?.clientY || 0) - startY;
        if (dy > 80 && refreshIndicator) {
            refreshIndicator.textContent = 'Refreshing...';
            // Trigger session reload
            if (window._coralLoadLiveSessions) {
                window._coralLoadLiveSessions();
            }
            setTimeout(() => {
                if (refreshIndicator && refreshIndicator.parentNode) {
                    refreshIndicator.remove();
                }
                refreshIndicator = null;
            }, 1000);
        } else {
            if (refreshIndicator && refreshIndicator.parentNode) {
                refreshIndicator.remove();
            }
            refreshIndicator = null;
        }
    }, { passive: true });
}

// ── Swipe Between Agents ──────────────────────────────────────────────────

function _initSwipeNavigation() {
    let touchStartX = 0;
    let touchStartY = 0;

    document.addEventListener('touchstart', (e) => {
        if (!isMobile()) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (!isMobile()) return;
        if (document.body.classList.contains('popout-mode')) return;

        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;

        // Only detect horizontal swipes (dx much larger than dy)
        if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;

        // Only swipe when viewing a live session and side panel is closed
        const liveView = document.getElementById('live-session-view');
        if (!liveView || liveView.style.display === 'none') return;
        const panel = document.getElementById('agentic-state');
        if (panel && panel.classList.contains('mobile-panel-overlay')) return;

        const sessions = state.liveSessions || [];
        if (sessions.length < 2) return;

        const currentId = state.currentSession?.session_id;
        const currentIdx = sessions.findIndex(s => s.session_id === currentId);
        if (currentIdx < 0) return;

        let nextIdx;
        if (dx > 0) {
            // Swipe right → previous agent
            nextIdx = currentIdx > 0 ? currentIdx - 1 : sessions.length - 1;
        } else {
            // Swipe left → next agent
            nextIdx = currentIdx < sessions.length - 1 ? currentIdx + 1 : 0;
        }

        const next = sessions[nextIdx];
        if (next && window.selectLiveSession) {
            window.selectLiveSession(next.name, next.agent_type, next.session_id, next.server);
        }
    }, { passive: true });
}

// ── Virtual Keyboard Detection & Viewport Height Tracking ─────────────────

function _initKeyboardDetection() {
    if (!window.visualViewport) return;

    // What the visual viewport leaves of the screen, in the page's own pixels: its height times its scale. A pinch zoom shrinks visualViewport.height (at 2x it is half the screen's), which is not
    // a keyboard and leaves the page its whole screen: read plainly, the zoom made the page, and the viewer (position fixed, height from this) half as tall, a screen with its lower half empty (#5493).
    const visibleHeight = () => Math.round(window.visualViewport.height * (window.visualViewport.scale || 1));

    // The page's height follows the visible screen on a phone's layout and on any touch screen (#7326): an iPad is wider than the phone layout, and its Safari answers a rotation, the keyboard going
    // away or a toolbar changing size with a stale 100dvh (a band under the page, sidebar and composer). A mouse-and-window desktop keeps the CSS's own 100dvh.
    const coarse = () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const follows = () => isMobile() || coarse();

    const updateViewportHeight = () => {
        if (!follows()) {
            document.documentElement.style.removeProperty('--visual-viewport-height');
            return;
        }
        const px = `${visibleHeight()}px`;
        if (document.documentElement.style.getPropertyValue('--visual-viewport-height') !== px) document.documentElement.style.setProperty('--visual-viewport-height', px); // not rewritten each frame while it is read again
    };

    // Track the initial viewport height to detect keyboard open/close
    let initialHeight = visibleHeight();
    updateViewportHeight();

    window.visualViewport.addEventListener('resize', () => {
        if (!follows()) return;
        updateViewportHeight();
        if (!isMobile()) return;

        // Keyboard is open when viewport shrinks significantly (>100px)
        const heightDiff = initialHeight - visibleHeight();
        const keyboardOpen = heightDiff > 100;

        document.body.classList.toggle('keyboard-open', keyboardOpen);
    });

    window.visualViewport.addEventListener('scroll', () => {
        // Prevent unwanted visualViewport scroll offset on mobile
        if (window.visualViewport.pageTop > 0) {
            window.scrollTo(0, 0);
        }
    });

    // Update initial height on orientation change
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            initialHeight = visibleHeight();
            updateViewportHeight();
        }, 300);
    });

    window.addEventListener('resize', () => {
        if (!document.body.classList.contains('keyboard-open')) {
            initialHeight = visibleHeight();
        }
        updateViewportHeight();
    });

    // Safari reports a height that is still the old one right after a rotation, after the keyboard is dismissed (no resize event comes), when a page comes back from the back-forward cache and when the
    // tab is shown again: read it again at each, now and a little later, so a stale height does not stay (#7326).
    // Read at once and then on each frame for a second: Safari's first answer is the old one, and the right one comes a few frames later. Frames, not timers: a timer set by a focusout during start-up (the page moves
    // the focus as it builds) landed in the start-up handler on a machine whose window has focus and not on one without, so the start-up golden differed by machine (Windows CI, #7326).
    const nextFrame = requestAnimationFrame.bind(window); // the browser's own, taken here: a page that counts its sidebar's frame requests (feed_message_golden) does not count this loop's
    const reread = () => {
        updateViewportHeight();
        const until = performance.now() + 1000;
        const tick = () => { updateViewportHeight(); if (performance.now() < until) nextFrame(tick); };
        nextFrame(tick);
    };
    window.addEventListener('orientationchange', reread);
    window.addEventListener('pageshow', reread);
    window.addEventListener('focusout', reread);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reread(); });
}

// ── Top Bar Height ────────────────────────────────────────────────────────

// Fixed overlays below the top bar (side panel, sidebar, backdrop) start at
// --top-bar-height. The bar's height is not a constant (44px touch targets on a
// coarse pointer, safe-area padding, wrapping), so it is measured.
function _initTopBarHeight() {
    const bar = document.querySelector('header.top-bar');
    if (!bar) return;
    const root = document.documentElement;
    const update = () => {
        const bottom = Math.ceil(bar.getBoundingClientRect().bottom);
        if (bottom > 0) root.style.setProperty('--top-bar-height', bottom + 'px');
    };
    // A ResizeObserver reports the bar's size once, before the first paint, so there is no need to measure it here: that forced the page's whole first style and layout
    // inside the startup task, ahead of the list (10 ms at a 4x slowdown, #4995). Without one, measure now.
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(bar); else update();
    window.addEventListener('resize', update);
}

// ── Initialize Mobile ─────────────────────────────────────────────────────

export function initMobile() {
    _initTopBarHeight();
    // Popout mode has no agent list, tab bar or swipe navigation.
    if (document.body.classList.contains('popout-mode')) {
        _initKeyboardDetection();
        return;
    }
    syncMobileHistoryList();
    syncMobileDocsList();
    syncMobileAnalyticsList();
    syncMobileInboxList();
    // Set default tab
    if (isMobile()) {
        switchMobileTab('agents');
    }

    // Wrap selectLiveSession for mobile navigation
    wrapSelectLiveSession();

    // Initialize touch gestures
    _initPullToRefresh();
    _initSwipeNavigation();

    // Detect virtual keyboard for hiding tab bar
    _initKeyboardDetection();

    // Listen for resize to toggle mobile/desktop
    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const mobile = isMobile();
        if (mobile !== wasMobile) {
            syncMobileHistoryList();
            syncMobileDocsList();
            syncMobileAnalyticsList();
            syncMobileInboxList();
            const list = document.getElementById('mobile-agent-list');
            const welcome = document.getElementById('welcome-screen');
            if (mobile) {
                syncMobileAgentList();
                if (welcome && welcome.style.display !== 'none') showView('mobile-agent-list');
            } else {
                restoreSidebarList();
                if (list && list.style.display !== 'none') showView('welcome-screen');
            }
            wasMobile = mobile;
        }
        const tabBar = document.querySelector('.mobile-tab-bar');
        if (!tabBar) return;

        if (!isMobile()) {
            // Restore side panel if resized to desktop
            const agenticState = document.getElementById('agentic-state');
            if (agenticState && agenticState.classList.contains('mobile-panel-overlay')) {
                agenticState.classList.remove('mobile-panel-overlay');
            }
            // Ensure tab bar stays hidden on desktop (CSS handles mobile)
            tabBar.style.display = '';
            // Restore sidebar visibility
            const sidebar = document.querySelector('.sidebar');
            const handle = document.querySelector('.sidebar-resize-handle');
            if (sidebar) sidebar.style.display = '';
            if (handle) handle.style.display = '';
        }
    });
}
