/* The Chats list and a history transcript (moved out of render.js, #4996; no behaviour change). */
import { historyServer } from './history_source.js';
import { identityKey } from './server_base.js';
import { state } from './state.js';
import { scrollBehavior } from './motion.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { renderSidebarTagDots } from './tags.js';
import { updateSectionVisibility } from './sidebar.js';
import { getCachedAgentAvailability } from './team_availability.js';
import { whenText } from './when_text.js';
import { renderTranscript } from './live_chat.js';
import { historyLabel } from './history_label.js';
import { browserLocal } from './safe_storage.js';
import { setAttr } from './dom_write.js';
import * as DT from './data_table.js'; // a static import: this file is in the startup graph, and a top-level await in it kept app.js from registering its DOMContentLoaded handler in time (#8538)
import { registerGroupSource, groupHeaderHtml, isGroupFolded, syncPaneGroupToggle, refreshGroupTable } from './sidebar_groups.js';


const chatTableStates = new Map();

/** The usual branches say nothing: only another one is worth a word in a row. */
const unusualBranch = b => !!b && !/^(main|master|trunk|develop)$/.test(b);
/** The provider as a text badge (never colour alone), only where it is not the usual Claude. */
function providerBadge(src) {
    const t = String(src || '').toLowerCase();
    if (!t || t === 'claude') return '';
    const word = t === 'gemini' || t === 'antigravity' ? 'agy' : t;
    return `<span class="chip chip-caps agy">${escapeHtml(word)}</span>`;
}
/** How long a chat went on, in words that cannot be taken for an age: "ran 21 min", "ran 2 h 5 min". */
function ranFor(sec) {
    if (sec == null || !(sec >= 0)) return '';
    const m = Math.round(sec / 60);
    if (m < 1) return 'ran under a minute';
    return m < 60 ? `ran ${m} min` : `ran ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
/** When a chat last spoke, in words ("today 14:32", "yesterday 17:20", "Oct 17", with the year when it is not this one: when_text.js, the same words as every other list), the full value for a tooltip and the time
 *  element, and "ran 21 min" for how long it went on. */
export function chatWhen(iso, durationSec, now = new Date()) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return null;
    return { day: whenText(iso, now), iso: d.toISOString(), full: d.toLocaleString(), ran: ranFor(durationSec) };
}

/** One chat's row in the list. */
function chatRowHtml(s) {
    const isGroup = s.type === 'group' || (s.session_id && s.session_id.startsWith('board:'));
    if (isGroup) {
        const projectName = s.title || s.session_id.replace(/^board:/, '');
        const label = projectName;
        const isActive = state.currentSession && state.currentSession.type === "board" && state.currentSession.name === projectName;
        const gwhen = chatWhen(s.updated_at, null);
        const gWhenTag = gwhen ? `<span class="session-time"><time datetime="${escapeAttr(gwhen.iso)}" title="${escapeAttr(gwhen.full)}">${escapeHtml(gwhen.day)}</time></span>` : '';
        const countInfo = s.message_count != null ? `<span class="session-meta">${escapeHtml(`${s.message_count} msgs`)}</span>` : "";
        const subsInfo = s.subscriber_count != null ? `<span class="session-meta">${escapeHtml(`${s.subscriber_count} members`)}</span>` : "";
        // laid out as a chat row (#6961): the title and its Group badge, then one line of facts: how many messages and members, and when
        const gfacts = [countInfo, subsInfo, gWhenTag].filter(Boolean).join('<span class="chat-sep" aria-hidden="true"> · </span>');
        return `<li class="${escapeAttr(isActive ? 'active' : '')}" data-on-click="board-open" data-board="${escapeAttr(identityKey(historyServer(), projectName))}"><button type="button" class="row-btn"${isActive ? ' aria-current="true"' : ''}>
            <div class="session-row-mid chat-row-title"><span class="session-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="chip chip-caps board-badge">Group</span></div>
            ${gfacts ? `<div class="session-row-bottom chat-row-facts">${gfacts}</div>` : ""}
        </button></li>`;
    }
    const label = historyLabel(s);
    const isActive = state.currentSession && state.currentSession.type === "history" && state.currentSession.name === s.session_id;
    // A chat is its title, then one line of facts: who, which branch (not the usual one), when, and how long it ran (#6580). The provider is a badge only where it is not Claude.
    const typeTag = providerBadge(s.source_type);
    const agentName = s.display_name || s.agent_name || "";
    const agentTag = agentName ? `<span class="sidebar-agent-name">${escapeHtml(agentName)}</span>` : "";
    const reminderTag = getCachedAgentAvailability(s)?.reminder
        ? `<span class="agent-reminder-icon" title="Periodic reminder active" aria-label="Periodic reminder active">⏰</span>`
        : "";
    const branchTag = unusualBranch(s.branch) ? `<span class="sidebar-branch">${escapeHtml(s.branch)}</span>` : "";
    const tagDots = s.tags ? renderSidebarTagDots(s.tags) : "";
    const when = chatWhen(s.last_timestamp, s.duration_sec);
    const whenTag = when ? `<span class="session-time"><time datetime="${escapeAttr(when.iso)}" title="${escapeAttr(when.full)}">${escapeHtml(when.day)}</time>${when.ran ? `, ${escapeHtml(when.ran)}` : ''}</span>` : '';
    const noWhen = !when ? '<span class="session-time">date unknown</span>' : '';
    const facts = [agentTag, branchTag, whenTag || noWhen].filter(Boolean).join('<span class="chat-sep" aria-hidden="true"> · </span>');
    return `<li class="${escapeAttr(isActive ? 'active' : '')}" data-on-click="history-open" data-session-id="${escapeAttr(s.session_id)}"><button type="button" class="row-btn"${isActive ? ' aria-current="true"' : ''}>
        <div class="session-row-mid chat-row-title"><span class="session-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${typeTag}${tagDots}${reminderTag}</div>
        ${facts ? `<div class="session-row-bottom chat-row-facts">${facts}</div>` : ""}
    </button></li>`;
}

// ── Groups (#7443): the list is grouped by day (the default) or by agent; a group's name opens it as a table in the centre, its chevron folds it ──

const GROUP_BY_KEY = 'coral-chats-group-by';
function chatsGroupBy() { return browserLocal.get(GROUP_BY_KEY) === 'agent' ? 'agent' : 'day'; }
export function setChatsGroupBy(by) {
    browserLocal.set(GROUP_BY_KEY, by === 'agent' ? 'agent' : 'day');
    syncGroupByButtons();
    redrawHistoryGroups();
}
export function syncGroupByButtons() {
    const by = chatsGroupBy();
    for (const b of document.querySelectorAll('.hf-toggle[data-chat-group]')) {
        const on = b.dataset.chatGroup === by;
        if (b.classList.contains('active') !== on) b.classList.toggle('active', on); // (a write of the value it has is still a mutation)
        setAttr(b, 'aria-pressed', String(on));
    }
}

const isGroupChat = s => s.type === 'group' || (s.session_id && s.session_id.startsWith('board:'));
/** The day a chat last spoke, as a group: Today, Yesterday, or Earlier. */
function dayGroup(iso, now = new Date()) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return { key: 'day-earlier', label: 'Earlier' };
    const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day0(now) - day0(d)) / 86400000);
    if (days <= 0) return { key: 'day-today', label: 'Today' };
    if (days === 1) return { key: 'day-yesterday', label: 'Yesterday' };
    return { key: 'day-earlier', label: 'Earlier' };
}

function groupOfChat(s) {
    if (chatsGroupBy() === 'agent') {
        if (isGroupChat(s)) return { key: 'group-chats', label: 'Board history' };
        const name = s.display_name || s.agent_name || '';
        return name ? { key: 'agent:' + name, label: name } : { key: 'no-agent', label: 'No agent' };
    }
    return dayGroup(isGroupChat(s) ? s.updated_at : s.last_timestamp);
}

/** The chats of the page, in the order they came, as groups. */
function chatGroups(sessions) {
    const groups = [], at = new Map();
    for (const s of sessions) {
        const g = groupOfChat(s);
        if (!at.has(g.key)) { at.set(g.key, groups.length); groups.push({ ...g, sessions: [] }); }
        groups[at.get(g.key)].sessions.push(s);
    }
    return groups;
}

let drawn = []; // the groups as last drawn
function drawHistoryGroups(list, sessions) {
    drawn = chatGroups(sessions);
    list.innerHTML = drawn.map(g => groupHeaderHtml('history', g.key, g.label, g.sessions.length)
        + (isGroupFolded('history', g.key) ? '' : g.sessions.map(chatRowHtml).join(''))).join('');
    syncPaneGroupToggle('history');
    refreshGroupTable('history');
}

function redrawHistoryGroups() {
    const list = document.getElementById('history-sessions-list');
    if (list && state.historySessionsList?.length) drawHistoryGroups(list, state.historySessionsList);
}

function chatTableRow(s) {
    if (isGroupChat(s)) {
        const name = s.title || s.session_id.replace(/^board:/, '');
        const when = chatWhen(s.updated_at, null);
        return { title: name, action: 'board-open', data: { board: identityKey(historyServer(), name) }, cells: ['Group chat', when ? when.day : '', ''] };
    }
    const when = chatWhen(s.last_timestamp, s.duration_sec);
    return { title: historyLabel(s), action: 'history-open', data: { 'session-id': s.session_id }, cells: [s.display_name || s.agent_name || '', when ? when.day : '', when ? when.ran.replace(/^ran /, '') : ''] };
}

/** The page of an open chat: the group it is in (for the way back) and the line under its title (who, when, how long it ran). */
export function describeChat(entry) {
    if (!entry) return { group: null, meta: '' };
    const when = chatWhen(isGroupChat(entry) ? entry.updated_at : entry.last_timestamp, entry.duration_sec);
    const meta = [entry.display_name || entry.agent_name || '', when ? when.day : '', when ? when.ran : ''].filter(Boolean).join(' \u00b7 ');
    return { group: groupOfChat(entry), meta };
}

// The chats the sidebar's search found (their session ids; a group chat is 'board:<name>'), or null with no search on: the page's table lists the same chats, so its counts agree with the sidebar's (#7722).
let searchMatches = null;
export function setChatSearchMatches(ids) { searchMatches = ids ? new Set(ids) : null; refreshGroupTable('history'); }
const matched = g => searchMatches ? g.sessions.filter(s => searchMatches.has(s.session_id)) : g.sessions;

registerGroupSource('history', {
    toolbar: () => ({ search: { id: 'history-search', label: 'Search chats' } }), // the page's toolbar line (#7723)
    keys: () => drawn.filter(g => matched(g).length || !searchMatches).map(g => g.key),
    redraw: redrawHistoryGroups,
    table: key => {
        const g = drawn.find(x => x.key === key);
        if (!g) return null;
        const rows = matched(g).map(s => ({ ...chatTableRow(s), id: s.session_id }));
        if (!chatTableStates.has(key)) chatTableStates.set(key, DT.tableState());
        return { title: g.label, rows, signature: JSON.stringify(rows), empty: searchMatches ? { line: 'No matching chats.' } : undefined,
            node: () => DT.dataTable({ label: `${g.label} chats, ${rows.length}`, rows, rowKey: r => r.id, rowName: r => r.title, state: chatTableStates.get(key), sortBar: false,
                open: r => r.action === 'board-open' ? window.selectBoardProject?.(r.data.board) : window.selectHistorySession?.(r.id),
                columns: [
                    { key: 'chat', label: 'Chat', primary: true, width: 'grow', line: 1, cell: r => { const b = DT.primaryButton(r.title); b.dataset.sessionId = r.id; return b; } },
                    { key: 'agent', label: 'Agent', line: 2, cell: r => r.cells[0] },
                    { key: 'when', label: 'When', tone: 'tertiary', line: 1, cell: r => r.cells[1] },
                    { key: 'ran', label: 'Ran', tone: 'tertiary', align: 'end', line: 2, cell: r => r.cells[2] },
                ] }).el };
    },
    isEmpty: () => document.getElementById('chats-empty-view')?.style.display === 'flex' && document.body.getAttribute('data-nav-tab') === 'history',
    showList: () => window.switchNavTab?.('history'),
    empty: () => window.switchNavTab?.('history'),
});

export function renderHistorySessions(sessions, total, page, pageSize) {
    const list = document.getElementById("history-sessions-list");
    state.historySessionsList = sessions || [];

    updateSectionVisibility('history', total || (sessions ? sessions.length : 0));

    if (!sessions || !sessions.length) {
        drawn = [];
        list.innerHTML = '<li class="empty-state empty-state-tight">No history found</li>';
        syncPaneGroupToggle('history');
        refreshGroupTable('history');
        renderPaginationControls(0, 1, 50);
        return;
    }

    drawHistoryGroups(list, sessions);

    if (total !== undefined) {
        renderPaginationControls(total, page || 1, pageSize || 50);
    }
}

function renderPaginationControls(total, page, pageSize) {
    let container = document.getElementById("history-pagination");
    if (!container) {
        // Create pagination container after the history list
        const list = document.getElementById("history-sessions-list");
        container = document.createElement("div");
        container.id = "history-pagination";
        container.className = "pagination-controls";
        list.parentNode.appendChild(container);
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1) {
        container.innerHTML = ''; // the section's heading says the count ("Chats 9"): not a second time here (#6961)
        return;
    }

    container.innerHTML = `
        <button class="btn btn-small" ${page <= 1 ? 'disabled' : ''} data-on-click="history-page" data-page="${Number(page - 1)}">Prev</button>
        <span class="pagination-info">${page} / ${totalPages}</span>
        <button class="btn btn-small" ${page >= totalPages ? 'disabled' : ''} data-on-click="history-page" data-page="${Number(page + 1)}">Next</button>
    `;
}

export function renderHistoryChat(messages, agentType = "claude", baseIndex = 0, focusIndex = null) {
    const container = document.getElementById("history-messages");
    container.innerHTML = "";
    container.append(...renderHistoryNodes(messages, agentType, baseIndex));
    container.scrollTop = container.scrollHeight;
    if (focusIndex != null) {
        requestAnimationFrame(() => {
            const target = container.querySelector(`[data-message-index="${CSS.escape(String(focusIndex))}"]`);
            if (target) {
                target.classList.add('chat-search-target');
                target.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
                target.setAttribute('tabindex', '-1');
                target.focus({ preventScroll: true });
            } else {
                const notice = document.createElement('div');
                notice.className = 'chat-search-status';
                notice.textContent = 'The matching message is no longer available.';
                container.prepend(notice);
            }
        });
    }
}

/** A page of the history transcript as nodes, not yet in the page (history_pages.js inserts
 *  pages above or below what is shown, #3718). Same renderer as the live Chat view: replies as
 *  prose, tool calls and their output folded into collapsed "N steps" groups. baseIndex is the
 *  first message's index in the whole transcript. */
export function renderHistoryNodes(messages, agentType = "claude", baseIndex = 0) {
    const holder = document.createElement("div");
    const normalized = messages.map((entry, index) => {
        const value = normalizeHistoryEntry(entry);
        if (value) value.__coralMessageIndex = baseIndex + index;
        return value;
    }).filter(Boolean);
    renderTranscript(normalized, holder, agentType);
    for (const bubble of holder.querySelectorAll(".chat-bubble.human")) {
        bubble.insertAdjacentHTML("beforeend",
            `<button class="edit-btn" data-history-local-only data-on-click="msg-edit-resubmit">Edit & Resubmit</button>`);
    }
    return [...holder.childNodes];
}

// The reader returns normalized entries; older raw JSONL entries (content
// nested under entry.message) are reduced to plain user/assistant text.
function normalizeHistoryEntry(entry) {
    if (entry.message) {
        const msg = entry.message;
        let content = "";
        if (typeof msg.content === "string") content = msg.content;
        else if (typeof msg.text === "string") content = msg.text;
        else if (Array.isArray(msg.content)) {
            content = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        }
        if (!content.trim()) return null;
        entry = (entry.type === "human" || entry.type === "user")
            ? { type: "user", content }
            : { type: "assistant", text: content };
    }
    if (entry.type === "human") return { ...entry, type: "user" };
    if (entry.type === "assistant") {
        const text = typeof entry.text === "string" ? entry.text : (typeof entry.content === "string" ? entry.content : "");
        return { ...entry, text };
    }
    return entry;
}
