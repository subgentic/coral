/* Moved out of render.js as it was (#3795): no behaviour change. */
import { getDotClass, resolveSessionIdentity, sessionGoalText, sessionStateInfo, sessionUnreadCount } from './session_state.js';
import { _saveSessionOrder } from './list_order.js';
import { MORE_DOTS_SVG, escapeHtml, escapeAttr, agentNameColor } from './utils.js';
import { autoAcceptChip, autoAcceptMenuItem } from './auto_accept.js';
import { getCachedAgentAvailability } from './team_availability.js';
import { isGoneAsleep, isExitedAsleep } from './terminal_gone.js';
import { isStaleSession, staleReason, serversShown } from './server_status.js';
import { sessionServer, keyLabel, sessionTeamKey, isCloud } from './server_base.js';
import { instructionsOffered } from './agent_instructions_offer.js';
import { redrawLiveList } from './list_hooks.js';
import { state } from './state.js';
import { skippedOf } from './waiting.js';
import { modelName, typeName } from './model_labels.js';
import { terminalGoneChip } from './terminal_gone.js';
import { hooksMissingChip } from './hooks_missing.js';
import { browserLocal } from './safe_storage.js';
import { syncDisplayPanels } from './display_panel.js';
import { setChecked, setHidden } from './dom_write.js';

// ── Archived section (#3030) ─────────────────────────────────────────────
// One global collapsed section at the bottom of the list. The grouping is all
// in here so it can become per-team later.
function _archivedTeamLabel(s) {
    return s.board_project ? keyLabel(sessionTeamKey(s)) : 'No team';
}

export function _renderArchivedSection(archived) {
    if (!archived.length) return '';
    const expanded = _isArchivedExpanded();
    let html = `<li class="sleeping-summary-row archived-summary-row" data-on-click="archived-toggle"><button type="button" class="row-btn" aria-expanded="${escapeAttr(expanded)}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="3" rx="0.5"/><path d="M3 6v7h10V6"/><path d="M6.5 9h3"/></svg>
        <span class="sleeping-summary-label">Archived (${archived.length})</span>
    </button></li>`;
    if (!expanded) return html;
    const byTeam = new Map();
    for (const s of archived) {
        const label = _archivedTeamLabel(s);
        if (!byTeam.has(label)) byTeam.set(label, []);
        byTeam.get(label).push(s);
    }
    // Agents with no team come first with no heading of their own (a heading "No team" was noise, #10086); each team's agents follow under its name.
    for (const s of byTeam.get('No team') || []) html += _renderSessionItem(s, '__archived__', true, false, '');
    for (const label of [...byTeam.keys()].filter(l => l !== 'No team').sort((a, b) => a.localeCompare(b))) {
        html += `<li class="archived-team-caption">${escapeHtml(label)}</li>`;
        for (const s of byTeam.get(label)) html += _renderSessionItem(s, '__archived__', true, false, '');
    }
    return html;
}

export function toggleArchivedSection() {
    try { browserLocal.set('coral-archived-expanded', _isArchivedExpanded() ? 'false' : 'true'); } catch { /* per-viewer only */ }
    redrawLiveList();
}

function _isArchivedExpanded() {
    try { return browserLocal.get('coral-archived-expanded') === 'true'; }
    catch { return false; }
}

// Drag-and-drop state
let _draggedSid = null;

// The text of each row's action menu, by the row's identity: drawn into the row when its menu opens (openRowMenu) and not before, so a list of 100 agents holds one menu's elements instead
// of a hundred. Every render sets each shown row's again (an agent whose state changed has a new row, which closes its menu as before); the oldest go past a thousand.
const rowMenus = new Map();
const rowMenuKey = (sid, server, name) => `${sid || ''}|${server || ''}|${name || ''}`;
function rememberRowMenu(s, html) {
    const key = rowMenuKey(s.session_id, sessionServer(s), s.name);
    rowMenus.delete(key);
    rowMenus.set(key, html);
    if (rowMenus.size > 1000) rowMenus.delete(rowMenus.keys().next().value);
}

/** Draw the menu of the row `btn` (its kebab button) belongs to into `menu`, and take every other row's drawn menu out. Returns false when the row's menu text is not known. */
export function openRowMenu(btn, menu) {
    for (const other of document.querySelectorAll('.sidebar-kebab-menu[data-lazy-menu][data-drawn]')) {
        if (other !== menu) { other.replaceChildren(); delete other.dataset.drawn; }
    }
    const row = btn.closest('.session-group-item');
    const html = row && rowMenus.get(rowMenuKey(row.dataset.sessionId, row.dataset.server, row.dataset.name));
    if (html === undefined) return false;
    if (!menu.dataset.drawn) { menu.innerHTML = html; menu.dataset.drawn = '1'; for (const it of menu.querySelectorAll('.overflow-menu-item')) if (!it.hasAttribute('role')) it.setAttribute('role', 'menuitem'); } // the auto-accept item is a menuitemcheckbox already
    return true;
}

/** A DOM id for a row's or group's menu, so its button can say aria-controls (#4621): the same on every render and different for every key (a short hash with the key's letters). */
export function kebabId(kind, key) {
    const k = String(key);
    let h = 5381;
    for (const c of k) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
    return `kebab-${kind}-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${h.toString(36)}`;
}

const LABEL_TAIL_FITS = 10, LABEL_TAIL_PARTS = 3, LABEL_SPLIT_OVER = 16;
/** [head, tail] for a name longer than 16 characters, else [name, '']: the tail is the last whole word or two (a word ends at a space, a hyphen, an underscore or a dot), so the end that tells agents apart stays and a cut never lands inside it ("Frontend… Teams UI"); a space between them stays at the end of the head. A name with no word that fits has no tail: its end gets the plain ellipsis. */
function splitLabel(name) {
    const full = String(name);
    if (Array.from(full).length <= LABEL_SPLIT_OVER) return [full, ''];
    const parts = full.match(/[^\s\-_.]*[\-_.]*\s*/gu).filter(Boolean);
    let tail = '';
    for (let i = parts.length - 1, n = 0; i > 0 && n < LABEL_TAIL_PARTS; i--, n++) {
        const next = parts[i] + tail;
        if (Array.from(next.trimEnd()).length > LABEL_TAIL_FITS) break;
        tail = next;
    }
    tail = tail.replace(/^\s+/u, '');
    while (tail && !/[\p{L}\p{N}]/u.test(tail.split(/\s/u)[0])) tail = tail.replace(/^\S*\s*/u, ''); // never begin on a bare "&" or "-"
    if (!tail) return [full, ''];
    return [full.slice(0, full.length - tail.length), tail];
}

/** What the phone's row shows besides the name (the sidebar hides these): the state chip, the unread count, and the banner for an agent that needs the person. */
/** The items of an agent row's action menu (drawn when it opens): the archived, sleeping or awake set. */
function _rowMenuContent(s, sid) {
    const _archiveItem = `
            <button class="menu-item overflow-menu-item" data-on-click="agent-archive" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" data-mode="archive">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="3" rx="0.5"/><path d="M3 6v7h10V6"/><path d="M6.5 9h3"/></svg>
                Archive
            </button>
`;
    const _sleepingMenu = `
            <a class="menu-item overflow-menu-item overflow-menu-open-window" href="/agent/${escapeAttr(sid)}" target="_blank" rel="noopener noreferrer" title="Open Agent Tab" aria-label="Open Agent Tab" data-on-click="kebab-close">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h5v5"/><path d="M14 2L7 9"/><path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg>
                Open Agent Tab
            </a>
            <button class="menu-item overflow-menu-item" data-on-click="agent-sleep" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" data-mode="wake">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 1 0 0 10 5 5 0 0 1 0-10z"/></svg>
                Wake
            </button>
${_archiveItem}            <button class="menu-item overflow-menu-item" data-on-click="agent-restart-same" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v4h4"/><path d="M3.5 6A5.5 5.5 0 1 1 2.5 8"/></svg>
                Restart, same settings
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-restart" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v4h4"/><path d="M3.5 6A5.5 5.5 0 1 1 2.5 8"/></svg>
                Restart with changes…
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-rename" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>
                Rename
            </button>
            ${!instructionsOffered(s, isCloud()) ? '' : `<button class="menu-item overflow-menu-item" data-on-click="agent-instructions" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" title="What this agent is told each time it starts; saved now, used at its next restart">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10M3 6.5h10M3 10h6"/><path d="M11.5 11.5l2 2"/></svg>
                Edit instructions
            </button>`}
            <button class="menu-item overflow-menu-item" data-on-click="agent-icon" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 9.5c0 0 1 1.5 2.5 1.5s2.5-1.5 2.5-1.5"/><circle cx="6" cy="6.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="10" cy="6.5" r="0.5" fill="currentColor" stroke="none"/></svg>
                Set Icon
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-info" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none"/></svg>
                Session Info
            </button>
            <hr class="overflow-menu-divider">
            <button class="menu-item overflow-menu-item" data-on-click="agent-move" data-session-id="${escapeAttr(sid)}" data-dir="up">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 7l4-4 4 4"/></svg>
                Move Up
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-move" data-session-id="${escapeAttr(sid)}" data-dir="down">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 9l4 4 4-4"/></svg>
                Move Down
            </button>
            <hr class="overflow-menu-divider">
            <button class="menu-item menu-item-danger overflow-menu-item overflow-menu-danger" data-on-click="agent-kill" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                Remove Agent
            </button>`;
    const _awakeMenu = `
            <a class="menu-item overflow-menu-item overflow-menu-open-window" href="/agent/${escapeAttr(sid)}" target="_blank" rel="noopener noreferrer" title="Open Agent Tab" aria-label="Open Agent Tab" data-on-click="kebab-close">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h5v5"/><path d="M14 2L7 9"/><path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg>
                Open Agent Tab
            </a>
            <button class="menu-item overflow-menu-item" data-on-click="agent-rename" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>
                Rename
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-sleep" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" data-mode="sleep">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 1 0 0 10 5 5 0 0 1 0-10z"/></svg>
                Sleep
            </button>
${_archiveItem}
            ${autoAcceptMenuItem(s)}
            ${!instructionsOffered(s, isCloud()) ? '' : `<button class="menu-item overflow-menu-item" data-on-click="agent-instructions" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" title="What this agent is told each time it starts; saved now, used at its next restart">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10M3 6.5h10M3 10h6"/><path d="M11.5 11.5l2 2"/></svg>
                Edit instructions
            </button>`}
            <button class="menu-item overflow-menu-item" data-local-only data-on-click="agent-attach" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,4 8,8 4,12"/><line x1="9" y1="12" x2="13" y2="12"/></svg>
                Attach
            </button>
            <button class="menu-item overflow-menu-item" type="button" data-on-click="team-menu-more" aria-expanded="false" aria-controls="agent-more-${escapeAttr(sid)}">More</button>
            <div id="agent-more-${escapeAttr(sid)}" class="team-menu-more" role="group" aria-label="More for ${escapeAttr(s.display_name || s.name)}" hidden>
            <button class="menu-item overflow-menu-item" data-on-click="agent-restart-same" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v4h4"/><path d="M3.5 6A5.5 5.5 0 1 1 2.5 8"/></svg>
                Restart, same settings
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-restart" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v4h4"/><path d="M3.5 6A5.5 5.5 0 1 1 2.5 8"/></svg>
                Restart with changes…
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-icon" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 9.5c0 0 1 1.5 2.5 1.5s2.5-1.5 2.5-1.5"/><circle cx="6" cy="6.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="10" cy="6.5" r="0.5" fill="currentColor" stroke="none"/></svg>
                Set Icon
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-info" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none"/></svg>
                Session Info
            </button>
            </div>
            <hr class="overflow-menu-divider">
            <button class="menu-item overflow-menu-item" data-on-click="agent-move" data-session-id="${escapeAttr(sid)}" data-dir="up">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 7l4-4 4 4"/></svg>
                Move Up
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-move" data-session-id="${escapeAttr(sid)}" data-dir="down">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 9l4 4 4-4"/></svg>
                Move Down
            </button>
            <hr class="overflow-menu-divider">
            <button class="menu-item menu-item-danger overflow-menu-item overflow-menu-danger" data-on-click="agent-kill" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                Kill Session
            </button>`;
    // Archived: no Restart, Rename or reordering (#3030).
    const _archivedMenu = `
            <a class="menu-item overflow-menu-item overflow-menu-open-window" href="/agent/${escapeAttr(sid)}" target="_blank" rel="noopener noreferrer" title="Open Agent Tab" aria-label="Open Agent Tab" data-on-click="kebab-close">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h5v5"/><path d="M14 2L7 9"/><path d="M12 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4"/></svg>
                Open Agent Tab
            </a>
            <button class="menu-item overflow-menu-item" data-on-click="agent-archive" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" data-mode="unarchive">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="3" rx="0.5"/><path d="M3 6v7h10V6"/><path d="M8 12V8M6 10l2-2 2 2"/></svg>
                Unarchive
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-sleep" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}" data-mode="wake">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 1 0 0 10 5 5 0 0 1 0-10z"/></svg>
                Wake
            </button>
            <button class="menu-item overflow-menu-item" data-on-click="agent-info" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none"/></svg>
                Session Info
            </button>
            <hr class="overflow-menu-divider">
            <button class="menu-item menu-item-danger overflow-menu-item overflow-menu-danger" data-on-click="agent-kill" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}" data-session-id="${escapeAttr(sid)}">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>
                Remove Agent
            </button>`;
    return s.archived ? _archivedMenu : (s.sleeping ? _sleepingMenu : _awakeMenu);
}

export function _renderSessionItem(s, groupName, isCompact, collapsed, teamDefaultDir) {
    const dotClass = getDotClass(s);
    const isActive = !state.selectedTeam && !state.atWelcome && state.currentSession && state.currentSession.type === "live" && state.currentSession.session_id === s.session_id;

    // Spec: remove agent type from the default row layout
    const typeTag = "";

    // Directory override chip
    // Directory override now lives in the tooltip (Directory row), not the row.
    const dirChip = "";

    // One pill at most, from the shared state table. The attention states carry a
    // warning pill; "Task assigned · idle" a neutral one (#3227). "Ready for input"
    // has none: the tooltip and the aria-label carry that state (no dot) (task #175).
    const stateInfo = sessionStateInfo(s);
    const pillKind = stateInfo.attention ? 'waiting-badge session-state-pill session-attention-pill' : 'session-state-pill';
    const waitingBadge = stateInfo.pill && stateInfo.attention // one row, one line: the one chip is for an agent that needs you (the dot says every other state, #9686)
        ? ` <span class="chip chip-caps ${pillKind}${stateInfo.pillClass ? ' ' + stateInfo.pillClass : ''}"${stateInfo.label !== stateInfo.pill.split(' · ')[0] ? ` title="${escapeAttr(stateInfo.label)}"` : ''}>${escapeHtml(stateInfo.pill.split(' · ')[0])}</span>` // one chip, one word: the reason (Question, Permission) is the chip's hover and the row's name, not in the pill (UI/UX, #9784)
        : '';
    // Context is secondary: any state pill owns line 1 and the ctx pill
    // collapses to the dot's ring, which survives on every glyph.
    // A message the paste gate held (the last automated one Coral did not type, #7727) is a state a person must see: the row's one chip, "Message held", when no attention chip owns it (Needs you wins; the hold stays in the tip and on the page).
    const skipped = s.sleeping || !(Number(s.board_unread) > 0) ? null : skippedOf(s);
    const heldChip = !waitingBadge && skipped ? ` <span class="chip chip-caps session-state-pill neutral session-held-chip" title="${escapeAttr(skipped.why)}">Message held</span>` : '';
    const ctxHigh = s.context_pct !== null && s.context_pct !== undefined && s.context_pct >= 80;
    const isTerminal = s.agent_type === "terminal";
    const sid = s.session_id || ""; // raw: every use below escapes it (it was escaped here too, and a second time at each use: an id with a quote or an ampersand reached the click handlers as "&#39;")
    // Row label follows the shared identity chain (display_name -> auto_name
    // -> board_job_title -> Agent/Terminal). The prompt is never a name; it
    // shows on the goal line below when there is no summary.
    const identity = resolveSessionIdentity(s);
    // An agent called by its folder under that folder's own group would read the same twice: its CLI tells it from the group ("my-app · Claude", #6029).
    const sameAsGroup = !isTerminal && groupName && String(identity).toLowerCase() === String(keyLabel(groupName)).toLowerCase() && typeName(s.agent_type);
    const displayLabel = sameAsGroup ? `${identity} \u00b7 ${typeName(s.agent_type)}` : identity;
    // A long name is cut with an ellipsis, and agents of one team share a prefix: its last word or two never shrink, so the end that tells them apart stays ("release-engineering-coo...-number-4-9").
    const [nameHead, nameTail] = stateInfo.attention ? [displayLabel, ''] : splitLabel(displayLabel); // attention tags must never consume the beginning of the name (#8268)
    const reminder = getCachedAgentAvailability(s);
    const reminderTag = reminder?.reminder
        ? `<span class="agent-reminder-icon" title="Periodic reminder every ${escapeAttr(Math.max(1, Math.round((reminder.reminder_interval_seconds || 300) / 60)))} min" aria-label="Periodic reminder active">⏰</span>`
        : '';
    const needsAttention = sessionNeedsAttention(s);
    const unreadCount = sessionUnreadCount(s); // said in the row's name for a screen reader; the row itself has no count
    const kebabMenuContent = _rowMenuContent(s, sid);
    // The menu's items (about 50 elements a row) are drawn when it opens (#4611): the row holds an empty menu and this module the text for it.
    rememberRowMenu(s, kebabMenuContent);
    const rowMenuId = kebabId('agent', rowMenuKey(s.session_id, sessionServer(s), s.name));
    const kebabMenu = `<div class="sidebar-kebab-wrapper">
        <button class="btn btn-quiet btn-icon btn-xs sidebar-kebab-btn" data-on-click="kebab-toggle" title="More actions" aria-label="More actions for ${escapeAttr(identity)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeAttr(rowMenuId)}">${MORE_DOTS_SVG}</button>
        <div class="menu sidebar-kebab-menu" id="${escapeAttr(rowMenuId)}" style="display:none" data-lazy-menu="1" role="menu" aria-label="Actions for ${escapeAttr(identity)}"></div>
    </div>`;
    const compactClass = isCompact ? ' session-compact' : '';
    const collapsedClass = collapsed ? ' group-collapsed' : '';
    const sleepingClass = s.sleeping ? ' sleeping' : '';
    const attentionClass = needsAttention ? ' needs-attention' : '';
    // Hub: an agent on an unreachable server is last-known data only.
    const stale = isStaleSession(s);
    const staleClass = stale ? ' session-stale' : '';
    // Its click opens the agent: data the session-open action reads.
    const clickHandler = stale ? '' : ` data-on-click="session-open" data-name="${escapeAttr(s.name)}" data-agent-type="${escapeAttr(s.agent_type)}"`;
    // Focusable list item (not a button: it contains the kebab, the open-tab
    // anchor and the sparkle). Selection is delegated (see _wireListKeyboard).
    const ariaLabel = `${sameAsGroup ? `${identity}, ${typeName(s.agent_type)}` : identity}, ${stateInfo.label}`
        + (ctxHigh ? `, context ${s.context_pct >= 100 ? 'full' : Math.round(s.context_pct) + '%'}` : '')
        + (unreadCount > 0 ? `, ${unreadCount} unread` : '')
        + (heldChip ? ', message held' : ''); // the row's one chip says it in words: the name says it too (QA Engineer, #9723)
    const stuckClass = stateInfo.key === 'stuck' ? ' is-stuck' : '';
    return `<li class="session-group-item list-row${isActive ? ' active list-row-current' : ''}${compactClass}${collapsedClass}${sleepingClass}${attentionClass}${stuckClass}${staleClass}"
        draggable="${stale ? 'false' : 'true'}"${stale ? ` aria-disabled="true" title="${escapeAttr(staleReason(s))}"` : ''}
        data-state="${escapeAttr(stateInfo.key)}"
        tabindex="0"
        aria-label="${escapeAttr(ariaLabel)}"${isActive ? ' aria-current="true"' : ''}
        data-session-id="${escapeAttr(sid)}"
        data-server="${escapeAttr(sessionServer(s))}"
        data-group="${escapeAttr(groupName)}"
        ${clickHandler}>
        <span class="drag-grip" title="Drag to reorder">&#x2630;</span>
        <div class="session-info">
            <div class="session-name-row">
                <span class="session-dot ${dotClass}${ctxHigh ? ' ctx-high' : ''}" aria-hidden="true"></span>
                <span class="session-label list-row-title${nameTail ? ' session-label-split' : ''}"><span class="session-label-name${s.agent_type === 'terminal' ? ' is-terminal' : ''}"${agentNameColor(s) ? ` style="--agent-name-color:${agentNameColor(s)}"` : ''}>${nameTail ? `<span class="sln-head">${escapeHtml(nameHead)}</span><span class="sln-tail">${escapeHtml(nameTail)}</span>` : escapeHtml(displayLabel)}</span>${nameTail ? `<span class="session-label-tags">${reminderTag}${typeTag}${dirChip}</span>` : `${reminderTag}${typeTag}${dirChip}`}</span>${autoAcceptChip(s)}${terminalGoneChip(s)}${hooksMissingChip(s)}
                <span class="session-name-spacer"></span>
                ${stale ? '' : waitingBadge + heldChip}
                ${stale ? '' : kebabMenu}
            </div>
            <span class="session-status-line">${escapeHtml(stateInfo.label)}</span>
            ${rowLinesHtml(s)}
        </div>
        <div class="session-tooltip"></div>
    </li>`;
}

function _renderSleepingSummary(sleepingAgents, groupName, isCompact, teamDefaultDir) {
    const count = sleepingAgents.length;
    const expanded = _isSleepingExpanded(groupName);
    // Agents Coral put to sleep when it stopped (sleep_reason coral_stopped) are said so,: a returning person sees what happened, not a bare "2 sleeping agents" (#10057; its Wake button went, #10814: too large for the line, each agent wakes from its own row).
    const restarted = sleepingAgents.filter(s => s.sleep_reason === 'coral_stopped'), k = restarted.length;
    const sleeping = `${count} sleeping agent${count !== 1 ? 's' : ''}`; // the same count and word as the team page's Sleeping chip (#10246); what came back asleep is said after it
    const label = k === 0 ? sleeping : k === count ? `${sleeping}, ${count === 1 ? '' : 'all '}after Coral restarted` : `${sleeping}, ${k} after Coral restarted`;
    const summaryName = `${label} in ${keyLabel(groupName)}`; // each folder's summary has its own name
    let html = `<li class="sleeping-summary-row" data-on-click="group-sleeping-expand" data-group="${escapeAttr(groupName)}"><button type="button" class="row-btn" aria-expanded="${escapeAttr(String(expanded))}" aria-label="${escapeAttr(summaryName)}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 1 0 0 10 5 5 0 0 1 0-10z"/></svg>
        <span class="sleeping-summary-label">${label}</span>
    </button></li>`;
    if (expanded) {
        for (const s of sleepingAgents) {
            html += _renderSessionItem(s, groupName, isCompact, false, teamDefaultDir);
        }
    }
    return html;
}

// A folder with many agents shows its first FOLDER_SHOWN and a "Show 19 more" row (#10319, Mobile pass 23), at every width (a phone's list is the one that needed it, and one rule is easier to know): the long list does not push the others out of the screen. The open agent stays in view (and is not counted among the hidden); Show fewer folds it again.
const FOLDER_SHOWN = 5;
const isMoreOpen = groupName => { try { return browserLocal.get(`coral-more-expanded:${groupName}`) === 'true'; } catch { return false; } };

export function _renderAgentListWithSubgroups(agents, teamDefaultDir, isCompact, groupName, limited = false) {
    if (!agents.length) return "";

    // An agent asleep because its terminal is gone stays in view with its "Terminal gone" chip
    // (#3344), not folded into the "N sleeping agents" row: it needs a Restart, not a nap.
    // One whose CLI exited stays in view too, with an "Ended" chip (#6058).
    const awake = agents.filter(s => !s.sleeping || isGoneAsleep(s) || isExitedAsleep(s));
    const sleeping = agents.filter(s => s.sleeping && !isGoneAsleep(s) && !isExitedAsleep(s));

    // One flat list: an agent's folder is shown in the header bar, not as
    // sidebar sub-groups.
    const folds = limited && awake.length > FOLDER_SHOWN, open = folds && isMoreOpen(groupName), openId = state.currentSession && state.currentSession.session_id;
    const shown = folds && !open ? awake.filter((s, i) => i < FOLDER_SHOWN || s.session_id === openId) : awake;
    let html = shown.map(s => _renderSessionItem(s, groupName, isCompact, false, teamDefaultDir)).join('');
    if (folds) {
        const more = awake.length - shown.length, label = open ? 'Show fewer' : `Show ${more} more`; const moreName = `${label} in ${keyLabel(groupName)}`;
        html += `<li class="sleeping-summary-row folder-more-row" data-on-click="group-more-expand" data-group="${escapeAttr(groupName)}"><button type="button" class="row-btn" aria-expanded="${escapeAttr(String(open))}" aria-label="${escapeAttr(moreName)}"><span class="sleeping-summary-label">${label}</span></button></li>`;
    }

    if (sleeping.length > 0) {
        html += _renderSleepingSummary(sleeping, groupName, isCompact, teamDefaultDir);
    }

    return html;
}

/** Show summary and Show model (#10816, after ce1946c0c): off unless on, kept per viewer; each adds one line. */
const ROW_LINE_KEY = { summary: 'coral-show-summary', model: 'coral-show-model' };
export function isRowLineShown(part) {
    try { return browserLocal.get(ROW_LINE_KEY[part]) === 'true'; } catch { return false; }
}
export function setRowLineShown(part, on) {
    try { browserLocal.set(ROW_LINE_KEY[part], on ? 'true' : 'false'); } catch { /* per-viewer only */ }
}
function rowLinesHtml(s) {
    const line = (cls, text) => text ? `<div class="${cls}">${escapeHtml(text)}</div>` : '';
    return line('session-line2', isRowLineShown('summary') && sessionGoalText(s)) + line('session-model', isRowLineShown('model') && s.agent_type !== 'terminal' && modelName(s.agent_type, s.model, sessionServer(s)));
}

/** 'Show server' (setting show_session_server): unset = on with 2+ servers, off with one. */
 export function isServerShownOnRows() {
    const v = String(state.settings?.show_session_server ?? '').toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return serversShown().length >= 2;
}

/** 'Group by server' (per viewer, off unless chosen); only with 2+ servers. */
 export function isGroupedByServer() {
    if (serversShown().length < 2) return false;
    try { return browserLocal.get('coral-group-by-server') === 'true'; } catch { return false; }
}

/** Sync the ≡ display menu's checkboxes and which options it offers: the sidebar's, and the phone's copy in the agent list
 *  header (#3991, the sidebar is hidden below 768 px). Both are found by data attributes, so each can appear once. It runs on every render of the
 *  list, so it looks only inside the two headers that hold the menu: an attribute selector over the whole document walked every node of the
 *  page (and of a long chat) each time (#4985). */
 export function syncDisplayMenu() {
    const n = serversShown().length;
    const checked = { summary: isRowLineShown('summary'), model: isRowLineShown('model'), server: isServerShownOnRows(), group: isGroupedByServer() };
    const offered = { summary: true, model: true, server: n >= 1, group: n >= 2 };
    for (const header of [...document.getElementsByClassName('sidebar-header'), ...document.getElementsByClassName('mobile-list-header')]) {
        for (const input of header.querySelectorAll('[data-display-input]')) setChecked(input, checked[input.dataset.displayInput] === true);
        for (const row of header.querySelectorAll('[data-display-row]')) setHidden(row, !offered[row.dataset.displayRow]);
        for (const btn of header.querySelectorAll('[data-display-button]')) btn.classList.toggle('active', n >= 1 && checked.server);
    }
    syncDisplayPanels(); // the phone's header is built later than the sidebar's: it takes the stored open or shut state here
}

function _isSleepingExpanded(groupName) {
    try { return browserLocal.get(`coral-sleeping-expanded:${groupName}`) === 'true'; }
    catch { return false; }
}

/** Row-level attention (amber/red tint + attention pill): the three states
 *  that need the operator at the terminal. */
 function sessionNeedsAttention(s) {
    return !!(s && sessionStateInfo(s).attention);
}

/** Elements matching `sel` among `roots` and their descendants. */
export function _within(roots, sel) {
    const out = [];
    for (const r of roots) {
        if (r.matches(sel)) out.push(r);
        out.push(...r.querySelectorAll(sel));
    }
    return out;
}

/** Wire drag-and-drop on the rows and containers under `roots` (the nodes a
 *  render added; kept nodes already have their listeners). */
export function _attachDragListeners(list, roots = [list]) {
    const items = _within(roots, ".session-group-item[draggable]");

    // Allow drops inside nested board-card-agents containers
    for (const container of _within(roots, ".board-card-agents")) {
        container.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        });
    }

    for (const item of items) {
        item.addEventListener("dragstart", (e) => {
            e.stopPropagation(); // Prevent board card from intercepting
            _draggedSid = item.dataset.sessionId;
            item.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            // Use a minimal drag image to avoid tooltip flash
            e.dataTransfer.setData("text/plain", _draggedSid);
        });

        item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
            _draggedSid = null;
            // Clear all drop indicators
            for (const el of list.querySelectorAll(".drag-over")) {
                el.classList.remove("drag-over");
            }
        });

        item.addEventListener("dragover", (e) => {
            e.preventDefault();
            if (!_draggedSid || _draggedSid === item.dataset.sessionId) return;
            // Only allow reorder within the same group
            const draggedEl = list.querySelector(`[data-session-id="${_draggedSid}"]`);
            if (!draggedEl || draggedEl.dataset.group !== item.dataset.group) return;
            e.dataTransfer.dropEffect = "move";
            item.classList.add("drag-over");
        });

        item.addEventListener("dragleave", () => {
            item.classList.remove("drag-over");
        });

        item.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.classList.remove("drag-over");
            if (!_draggedSid || _draggedSid === item.dataset.sessionId) return;

            const group = item.dataset.group;
            const draggedEl = list.querySelector(`[data-session-id="${_draggedSid}"]`);
            if (!draggedEl || draggedEl.dataset.group !== group) return;

            // Gather current order of session_ids in this group
            const groupItems = [...list.querySelectorAll(".session-group-item")].filter(el => el.dataset.group === group);
            const ids = groupItems.map(el => el.dataset.sessionId);

            // Remove dragged from its position and insert before drop target
            const fromIdx = ids.indexOf(_draggedSid);
            const toIdx = ids.indexOf(item.dataset.sessionId);
            if (fromIdx === -1 || toIdx === -1) return;

            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, _draggedSid);

            // Save all session IDs in current DOM order (preserves other groups)
            const allItems = [...list.querySelectorAll(".session-group-item")];
            const allIds = allItems.map(el => el.dataset.sessionId);
            // Replace the current group's IDs with the reordered ones
            const groupSet = new Set(ids);
            const merged = [];
            let groupInserted = false;
            for (const sid of allIds) {
                if (groupSet.has(sid)) {
                    if (!groupInserted) {
                        merged.push(...ids);
                        groupInserted = true;
                    }
                } else {
                    merged.push(sid);
                }
            }
            if (!groupInserted) merged.push(...ids);

            // Save and re-render
            _saveSessionOrder(merged);
            redrawLiveList();
        });
    }
}

