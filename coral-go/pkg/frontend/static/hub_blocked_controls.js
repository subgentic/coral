/* Controls the Coral Hub's access tier does not allow (#3769). Through the Hub a machine can be limited to View
 * or Interact: the server refuses what needs more, but a control that looks available and answers with a
 * "Blocked" toast only when clicked is misleading. Each control that needs Interact (send, keys, macros, Rename,
 * Archive, turning auto-accept off) or Launch (Kill, Sleep, Wake and Restart of one agent since #4274; Sleep all and Wake all, a team's
 * sleep, a board's pause and a board message's delete since #3942; turning auto-accept on) is dimmed and gets the reason as its title when its
 * agent's machine is below that tier. It stays clickable: the click still says why (hubBlocked, or the
 * hub's refusal). Which tier each needs follows the hub's route table (pkg/tunnel/routes.go).
 *
 * Agent rows and their menus use that row's machine; the command pane and the sleeping bar use the agent on
 * screen, which is also marked read-only when the hub told the terminal socket so. Controls are found by their
 * action name after any redraw, so the many places that draw them need no change. Not on a local dashboard. */
import { state } from './state.js';
import { isCloud, sessionServer, splitKey } from './server_base.js';
import { blockedReason } from './hub_access.js';
import { remoteServers } from './launch_server.js';
import { pollEvery } from './overload.js';

// Pinned to the route table (testdata/cloud_routes.golden) by TestDashboardModeTextMatchesTheRouteTable (#4526): since #4274
// stopping, sleeping and waking one agent need Launch, as a team's or every agent's do.
const INTERACT = new Set(['cmd-send', 'cmd-send-menu', 'send-menu-send', 'send-menu-team', 'send-menu-resend',
    'send-menu-protocol', 'cmd-quick', 'cmd-raw-keys', 'cmd-macro', 'macro-show', 'macro-delete', 'cmd-mode-toggle',
    'agent-rename', 'agent-icon', 'agent-archive', 'mb-post']);
const LAUNCH = new Set(['agent-restart', 'agent-restart-same', 'agent-attach', 'agent-kill', 'agent-sleep', 'team-sleep', 'board-chat-pause', 'mb-pause', 'mb-msg-delete', 'mb-delete-board', 'team-delete',
    'attach-image']); // POST /api/upload writes a file on the host: Launch (#6088)
// Turning auto-accept on needs Launch, turning it off Interact: the menu item says which by aria-checked.
const AUTO_ACCEPT = 'agent-auto-accept';
// The New agent / New team cards of the home screen start something on a computer: dimmed when NO connected computer allows Launch (#11463 F3: at View the four cards looked usable and only said no after the dialog and a click).
const NEEDS_LAUNCH_ANYWHERE = new Set(['m-show-launch-modal-then-select-launch-type']);
// What #3942 moved to Launch through the Hub: sleeping a team, pausing a board and deleting a board message.
// Team sleep and a board's pause and delete act on the machine that holds the board.
const BOARD = new Set(['mb-post', 'team-sleep', 'board-chat-pause', 'mb-pause', 'mb-msg-delete', 'mb-delete-board', 'team-delete']);
// The sleeping bar's buttons name their action in data-action.
const BAR = { wake: 'launch', restart: 'launch', unarchive: 'interact' };

function tierOf(el) {
    if (el.closest('#sleeping-composer')) return BAR[el.dataset.action] || '';
    const a = el.dataset.onClick;
    if (NEEDS_LAUNCH_ANYWHERE.has(a)) return 'launch-any';
    if (a === 'attach-image') return 'launch'; // before the phone's round buttons: its Add image button is one of them
    if (el.classList.contains('mobile-send-btn')) return 'interact';
    if (a === AUTO_ACCEPT) return el.getAttribute('aria-checked') === 'true' ? 'interact' : 'launch';
    return INTERACT.has(a) ? 'interact' : LAUNCH.has(a) ? 'launch' : '';
}

function serverOf(el) {
    const row = el.closest('[data-session-id]');
    const id = (row && row.dataset.sessionId) || el.dataset.sessionId;
    if (id) {
        const s = (state.liveSessions || []).find(x => x.session_id === id);
        if (s) return sessionServer(s);
    }
    return state.currentSession ? sessionServer(state.currentSession) : '';
}

// The machine a board control acts on: the board named on the control (a team menu, the board panel), else the board that is open.
function boardServerOf(el) {
    const b = el.dataset.board;
    return b ? splitKey(b).server : (state.currentBoardServer || '');
}

/** The reason when every connected computer is below Launch (the first one's words), '' when one allows it or none is known. */
function noComputerLaunches() {
    const rs = remoteServers(state.servers);
    let first = '';
    if (!rs.length) return '';
    for (const s of rs) { const r = blockedReason(s.id, 'launch'); if (!r) return ''; first = first || r; }
    return first;
}

function reasonFor(el, tier) {
    if (tier === 'launch-any') return noComputerLaunches();
    const a = el.dataset.onClick;
    if (BOARD.has(a)) return blockedReason(boardServerOf(el), tier);
    const r = blockedReason(serverOf(el), tier);
    if (r) return r;
    // The hub's own word on the terminal socket for the agent on screen (it stays until the agent is selected again;
    // what the Servers list says is checked first and is always current).
    const ro = state.currentSession && state.currentSession.hubReadOnly;
    return tier === 'interact' && ro && ro.fromFrame && !el.closest('[data-session-id]') ? ro.message : '';
}

/** Mark (or unmark) every control under `root` by what its agent's machine allows. */
export function markBlockedControls(root = document) {
    for (const el of root.querySelectorAll('[data-on-click], #sleeping-composer button[data-action], .mobile-send-btn')) {
        const tier = tierOf(el);
        const was = el.classList.contains('hub-blocked');
        // A control with no tier of its own is another module's to dim (the launch dialog's buttons, #4586): only what this scan marked is cleared.
        if (!tier) { if (el.dataset.hubBlockedTip) _clear(el); continue; }
        const reason = reasonFor(el, tier);
        if (reason) {
            el.classList.add('hub-blocked');
            el.setAttribute('aria-disabled', 'true');
            // The reason replaces the control's own tip (title, and the custom tooltip some carry) until it is allowed again.
            if (!el.dataset.hubBlockedTip) {
                el.dataset.hubBlockedTip = '1';
                el.dataset.hubOrigTitle = el.getAttribute('title') ?? '\u0000';
                if (el.hasAttribute('data-tooltip')) el.dataset.hubOrigTooltip = el.getAttribute('data-tooltip');
            }
            el.title = reason;
            if (el.hasAttribute('data-tooltip')) el.setAttribute('data-tooltip', reason);
        } else if (was) _clear(el);
    }
}

function _clear(el) {
    el.classList.remove('hub-blocked');
    el.removeAttribute('aria-disabled');
    if (el.dataset.hubBlockedTip) {
        const t = el.dataset.hubOrigTitle;
        if (t === '\u0000') el.removeAttribute('title'); else el.setAttribute('title', t);
        if ('hubOrigTooltip' in el.dataset) el.setAttribute('data-tooltip', el.dataset.hubOrigTooltip);
        delete el.dataset.hubBlockedTip; delete el.dataset.hubOrigTitle; delete el.dataset.hubOrigTooltip;
    }
}

let _timer = 0;
function _soon() {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = 0; markBlockedControls(); }, 120);
}

if (typeof document !== 'undefined') {
    document.addEventListener('coral:hub-access-changed', _soon);
    document.addEventListener('coral:server-access-loaded', _soon);
    if (isCloud()) {
        new MutationObserver(_soon).observe(document.body || document.documentElement, { childList: true, subtree: true });
        // A redraw that changes nothing draws nothing new, and the hub's list is cached for 15 s: look again now and then, so a
        // tier changed at the hub shows up here without a click.
        pollEvery(() => markBlockedControls(), 5000);
        _soon();
    }
}
