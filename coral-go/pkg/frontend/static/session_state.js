import { hasWorkingDisplayHint, trackDisplayHint } from './display_activity_hint.js';
/* Moved out of render.js as it was (#3795): no behaviour change. */
import { isPhoneLayout } from './phone_layout.js';
import { modelDisplayName } from './model_names.js';
import { sessionLevel, typeName } from './model_labels.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { factsHtml } from './facts.js';
import { formatTokens, formatCost } from './format.js';
import { getCachedAgentAvailability } from './team_availability.js';
import { isGoneAsleep } from './terminal_gone.js';
import { keyLabel, sessionTeamKey } from './server_base.js';
import { setClassName, setTitle, setAttr } from './dom_write.js';

/* ── Session identity ───────────────────────────────────────────────── */
const GOAL_LINE_MAX = 140;

/** Collapse whitespace/newlines and truncate to one line. */
 function oneLine(text, max = GOAL_LINE_MAX) {
    if (!text) return '';
    const flat = String(text).replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return flat.slice(0, max - 1).trimEnd() + '\u2026';
}

/** Goal text for a session row: summary, else the first user prompt (Show summary, #10816). */
 export function sessionGoalText(s) {
    return s ? oneLine(s.summary || s.first_prompt || '') : '';
}

/**
 * Stable identity source for a session, or '' when there is none.
 * Chain: display_name -> auto_name (D8, transcript-derived, write-once) ->
 * board_job_title. Neither summary nor first_prompt is identity: the summary
 * changes as the agent works, and a prompt is a sentence or a path, not a
 * name (task #85). Both are rendered as goal text only.
 */
 function sessionIdentitySource(s) {
    if (!s) return '';
    return (s.display_name || '').trim()
        || (s.auto_name || '').trim()
        || (s.board_job_title || '').trim();
}

// Placeholder of the command box: who it goes to, and that an image can be pasted. The agent's type is in the header and the board's name in the sidebar, so neither is repeated here
// (the board's generated id used to be, #5991). It is one line, never wrapped (the stylesheet cuts it with an ellipsis), and a name longer than NAME_IN_BOX characters is not put in it: "this agent"
// (#8206: a 60-character name made the phone's box seven lines tall).
const NAME_IN_BOX = 24;
const nameInBox = (identity) => (String(identity).length > NAME_IN_BOX ? 'this agent' : identity);
export function commandPlaceholder(identity, agentType) {
    const name = nameInBox(identity);
    if (isPhoneLayout()) return 'Message\u2026'; // the phone's box holds about 16 characters beside its buttons, and the header names the agent
    if (agentType === 'terminal') return `Type a command in ${name}`;
    return `Message ${name}, @ to mention a file, or paste an image`; // the box teaches @ (#10147): a file of the project is mentioned, not attached
}

/** The box's words while a new agent's CLI is not up yet (#6382): it says so. That a message typed now is held for it is on Send's own title (agent_starting.js), not in the box. */
export function startingPlaceholder(identity) {
    return isPhoneLayout() ? 'Starting\u2026' : `Starting ${nameInBox(identity)}\u2026`;
}

/** What an agent waits for, in words a person reads: the tool's name is not one ("Wants to use AskUserQuestion" is a question for the person; the sentence with the question in it, "Wants to know: Pick a color", is kept as it is). Display text only (#10195). */
export function askWords(summary) {
    const t = String(summary || '').replace(/\s+/g, ' ').trim();
    return /^(Notification: )?Wants to use AskUserQuestion$/i.test(t) ? 'Has a question for you' : t;
}

/** Shared identity resolver used by row label, avatar, header, terminal label and placeholder. */
export function resolveSessionIdentity(s) {
    if (!s) return 'Agent';
    const src = sessionIdentitySource(s);
    if (src) return oneLine(src, 60);
    if (s.agent_type === 'terminal') return 'Terminal';
    // An agent nobody named is called by the folder it works in, else by its CLI (the home folder is no name): "my-app", "Claude", not "Agent" (#5990). A second agent with the same default is "Claude 2" (the server numbers them, #10249).
    const base = defaultAgentName(s.working_directory, s.agent_type);
    return Number(s.name_number) > 1 ? `${base} ${Number(s.name_number)}` : base;
}

/** The name an unnamed agent shows: its folder's name (not the home folder, the root or a drive), else the CLI's name, else "Agent". */
export function defaultAgentName(dir, agentType) {
    const trim = p => String(p || '').trim().replace(/[\\/]+$/, '');
    const d = trim(dir), root = trim(typeof document !== 'undefined' ? document.body?.dataset?.coralRoot : '');
    const folder = d && d !== '~' && d !== root && !/^[A-Za-z]:$/.test(d) ? d.split(/[\\/]/).pop() : '';
    return oneLine(folder, 60) || typeName(agentType) || 'Agent';
}

export function formatShortTime(isoStr) {
    const d = new Date(isoStr);
    if (isNaN(d)) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}

function formatStaleness(seconds) {
    if (seconds === null || seconds === undefined) return "Unknown";
    if (seconds < 5) return "Just now";
    if (seconds < 60) return `${Math.floor(seconds)}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
}

/* ── Agent state: one resolver, one vocabulary ─────────────────────────
 * Priority (AGENT_LIST_COMPACT state table):
 *   Sleeping > Stuck > Needs input > Check terminal
 *   > Ready for input (turn ended, awaiting instruction) > Working > Idle
 * Context, unread and selection are overlays, never winners. Every surface
 * (row dot/pill/aria, tooltip, mobile chip, workspace header, popout pill,
 * nav and group counts) reads this table so the words never diverge. */
 export const SESSION_STATES = {
    sleeping:       { label: 'Sleeping',       dot: 'sleeping',  pill: null,             pillClass: '',          chip: 'idle',        attention: false },
    stuck:          { label: 'Stuck',          dot: 'stuck',     pill: 'Stuck',          pillClass: 'stuck',     chip: 'error',       attention: true },
    needs_input:    { label: 'Needs input',    dot: 'waiting',   pill: 'Needs input',    pillClass: '',          chip: 'needs-input', attention: true },
    check_terminal: { label: 'Check terminal', dot: 'waiting',   pill: 'Check terminal', pillClass: '',          chip: 'needs-input', attention: true },
    your_turn:      { label: 'Ready for input', dot: 'your-turn', pill: null,            pillClass: '',          chip: '',            attention: false },
    working:        { label: 'Working',        dot: 'working',   pill: null,             pillClass: '',          chip: 'running',     attention: false },
    // Not urgent: a muted ring + neutral pill, never the yellow of Needs input (#3227).
    task_idle:      { label: 'Task assigned · idle', dot: 'task-idle', pill: 'Idle · task', pillClass: 'neutral', chip: 'idle', attention: false },
    // Waiting on a teammate's reply, a task or a commit (coral-board wait): calm, like
    // task_idle; nobody's input is needed (#3471). The label names what it waits on.
    waiting_on:     { label: 'Waiting on the board', dot: 'task-idle', pill: 'Waiting', pillClass: 'neutral', chip: 'idle', attention: false },
    idle:           { label: 'Idle',           dot: 'stale',     pill: null,             pillClass: '',          chip: 'idle',        attention: false },
};

/** Turn ended and the agent awaits its next instruction. Backend contract:
 *  `awaiting_user` (boolean, explicit). Servers without the field still send
 *  the stop-derived `done`, which means exactly this (never "completed"). */
function _isAwaitingUser(s) {
    if (s.awaiting_user !== undefined && s.awaiting_user !== null) return !!s.awaiting_user;
    return !!s.done;
}

/** Resolve the single winning state key for a session. */
export function deriveSessionState(s, opts = {}) {
    if (!s) return 'idle';
    if (s.sleeping) return 'sleeping';
    if (s.stuck) return 'stuck';
    if (s.waiting_for_input) return 'needs_input';
    if (s.not_started) return 'check_terminal';
    const availability = getCachedAgentAvailability(s)?.availability;
    if (availability === 'waiting' && !s.working) return 'waiting_on';
    if (availability === 'task_idle') return 'task_idle';
    if (_isAwaitingUser(s)) return 'your_turn';
    if (s.working) return 'working';
    return 'idle';
}

/** "Waiting on Lead Developer", "Waiting on task #12", from a registered board wait. */
function waitingOnLabel(w) {
    if (!w) return '';
    const id = String(w.target_id || '').trim();
    switch (w.wait_type) {
        case 'message': return id ? `Waiting on ${id}` : 'Waiting on a board message';
        case 'task': return id ? `Waiting on task #${id}` : 'Waiting on a task update';
        case 'commit': return id ? `Waiting on commit ${id.slice(0, 12)}` : 'Waiting on a commit';
        default: return id ? `Waiting on ${id}` : '';
    }
}

// UI classification only. deriveSessionState remains the authoritative resolver
// used by send/queue/approval helpers and must never consume screen evidence.
export function presentationSessionState(s, opts) {
    const key = deriveSessionState(s, opts);
    trackDisplayHint(s);
    return key === 'needs_input' && hasWorkingDisplayHint(s) ? 'working' : key;
}

export function sessionStateInfo(s, opts) {
    const key = presentationSessionState(s, opts);
    const info = { key, ...SESSION_STATES[key] };
    // Asleep because its terminal session is gone, not because anyone asked (#3344): the
    // same state, said plainly. The row's "Terminal gone" chip restarts it.
    if (key === 'sleeping' && isGoneAsleep(s)) info.label = 'Terminal gone';
    // Asleep because its CLI exited (#6058): the word is "Ended", in the row and the header, not a plain "Sleeping".
    if (key === 'sleeping' && !s.archived && s.sleep_reason === 'agent_exited') info.label = info.pill = 'Ended';
    if (key === 'waiting_on') info.label = waitingOnLabel(getCachedAgentAvailability(s)?.waiting_on) || info.label;
    // What the agent itself says it waits on (#3481): its permission, question, plan or
    // input request. A prompt Coral only saw on the screen has no kind: plain Needs input.
    // waiting_kind comes from the agent's own event: only an own key of the table counts
    // (never 'constructor' or 'toString' from the prototype; QA's review).
    if (key === 'needs_input' && Object.hasOwn(WAITING_KINDS, s.waiting_kind || '')) {
        info.label = info.pill = `Needs input · ${WAITING_KINDS[s.waiting_kind]}`;
    }
    return info;
}

/** waiting_kind (from the agent's own request) → the word shown after Needs input. */
const WAITING_KINDS = { permission: 'Permission', question: 'Question', plan: 'Plan', elicitation: 'Input', login: 'Sign in' };

function getStateLabel(s) {
    return sessionStateInfo(s).label;
}

/** Class list for the workspace header status dot (same table as the rows). */
export function terminalDotClass(s) {
    return `terminal-status-dot ${sessionStateInfo(s || {}).dot}`;
}

/** The agent header's status dot (#4327, from the #4276 audit): its class, its tip and its accessible name all say the state in the sidebar's
 *  words, so it is not colour only. The header draws only the dot (the operator, #9927): there is no word beside it. */
const STATE_WORD = { your_turn: 'Ready', task_idle: 'Idle', waiting_on: 'Waiting', check_terminal: 'Check' }; // the long labels, in a word that fits a phone's header
export function applyTerminalDot(dot, s) {
    if (!dot) return;
    const info = sessionStateInfo(s || {});
    setClassName(dot, terminalDotClass(s));
    setTitle(dot, info.label);
    setAttr(dot, 'role', 'img');
    setAttr(dot, 'aria-label', info.label);
    setAttr(dot, 'data-word', STATE_WORD[info.key] || info.label); // a phone's header says it beside the dot (#10885: a hollow circle with no label)
    // Stop (Escape) has something to stop only while the agent works, asks or is stuck: in the chat view it is hidden otherwise (#7065); the terminal's Esc key stays
    setAttr(document.getElementById('command-pane'), 'data-can-stop', ['working', 'needs_input', 'check_terminal', 'stuck'].includes(info.key) ? 'true' : 'false');
}

/** The hover card's facts (#9999): only what the row does not already show and that has a value. opts.nameCut: the row cut the name, so the whole name is a fact; opts.inTeam: the row sits under its team's heading, so the team is not. */
export function buildSessionTooltip(s, opts = {}) {
    const stateLabel = getStateLabel(s);
    const lastAction = formatStaleness(s.staleness_seconds);
    const goal = s.summary || "";
    const instructions = s.agent_type !== 'terminal' && String(s.prompt || '').trim() ? oneLine(s.prompt, 120) : '';
    const status = s.status || "";
    const branchName = s.branch ? _repoBranch(s.repo_name, s.branch) || "" : ""; // no branch on record: no row, not the repository name alone
    const branch = branchName ? branchName + (s.git_state?.is_worktree ? " (worktree)" : "") : "";
    const agent = s.agent_type || "claude";

    const rows = [
        ...(opts.nameCut ? [{ label: 'Name', text: resolveSessionIdentity(s) }] : []), // the row cut its name to its width and has no native title any more (it covered the next row, #9822): the whole name is here, when it was cut
        { label: 'State', text: stateLabel, cls: `tt-state-${stateLabel.toLowerCase().replace(/ /g, '-')}` },
        { label: 'Last action', text: lastAction },
        ...(goal ? [{ label: 'Goal', text: goal }] : []),
        ...(status ? [{ label: 'Status', text: status }] : []),
        ...(instructions ? [{ label: 'Instructions', text: instructions, title: String(s.prompt).trim().slice(0, 500) }] : []), // its standing instructions, one line (#10285)
        ...(branch ? [{ label: 'Branch', text: branch }] : []),
        { label: 'Agent', text: agent },
    ];
    if (hasWorkingDisplayHint(s)) rows.push({ label: 'Permission', text: 'Codex’s terminal shows activity. Permission is not confirmed resolved; queued messages remain held.' });
    // The model the agent is using now, from the CLI's own signals; no row while it is unknown (#4589).
    const modelName = modelDisplayName(s.model, s.model_display);
    if (modelName) rows.push({ label: 'Model', text: modelName, title: typeof s.model === 'string' ? s.model.trim() : '' });
    // The thinking (effort) level, as the chat bar's chip says it; "requested" while only the level it was started with is known; no row when none is on record.
    const level = sessionLevel(s);
    if (level) rows.push({ label: 'Thinking', text: `${level.name}${level.requested ? ' (as started)' : ''}` });
    // Context window usage moved out of the row (AGENT_LIST_COMPACT): explicit
    // null (unknown model) must read "unknown", never 0% or full.
    if (s.context_pct !== null && s.context_pct !== undefined) rows.push({ label: 'Context', text: s.context_window ? `${s.context_pct}% of ${formatTokens(s.context_window)}` : `${s.context_pct}%` }); // no row while it is unknown: a word that says nothing is not a fact (#9999)
    if (s.working_directory) rows.push({ label: 'Directory', text: _shortPath(s.working_directory, 3), title: s.working_directory });
    if (s.changed_file_count > 0) rows.push({ label: 'Files changed', text: String(s.changed_file_count) });
    if (s.token_cost_usd > 0 || s.token_input > 0) {
        const tokIn = formatTokens(s.token_input || 0);
        const tokOut = formatTokens(s.token_output || 0);
        const tokCache = (s.token_cache_read || 0);
        let tokenText = `${tokIn} in / ${tokOut} out`;
        if (tokCache > 0) tokenText += ` / ${formatTokens(tokCache)} cache`;
        if (s.token_cost_usd > 0) tokenText += ` · ${formatCost(s.token_cost_usd)}`;
        rows.push({ label: 'Tokens', html: tokenText });
    }
    if (s.board_project) {
        const ttUnread = sessionUnreadCount(s);
        const unreadBadge = ttUnread > 0 ? ` <span class="tt-unread">(${ttUnread} unread)</span>` : '';
        if (!opts.inTeam || ttUnread > 0) rows.push({ label: 'Board', html: `${escapeHtml(keyLabel(sessionTeamKey(s)))}${unreadBadge}` }); // under its team's heading the row says the team; the unread count is still news
        if (s.board_job_title && String(s.board_job_title).trim().toLowerCase() !== String(resolveSessionIdentity(s)).trim().toLowerCase()) rows.push({ label: 'Role', text: s.board_job_title }); // a role that is the agent's own name is the row
    }
    return factsHtml(rows, { cls: 'session-tooltip-facts' });
}

export function getDotClass(s) {
    return sessionStateInfo(s).dot;
}

/** Compact "↑2 ↓1 ●3" divergence summary for a session's git_state, or ''.
 *  Ahead/behind are measured against the repo's default branch. */
export function _gitStateSummary(gs) {
    if (!gs) return '';
    const base = gs.base_branch || 'main';
    const parts = [];
    if (gs.ahead) parts.push(`<span class="gs-ahead" title="${escapeAttr(gs.ahead)} commit${gs.ahead !== 1 ? 's' : ''} ahead of ${escapeAttr(base)}">↑${gs.ahead}</span>`);
    if (gs.behind) parts.push(`<span class="gs-behind" title="${escapeAttr(gs.behind)} commit${gs.behind !== 1 ? 's' : ''} behind ${escapeAttr(base)}">↓${gs.behind}</span>`);
    if (gs.dirty) parts.push(`<span class="gs-dirty" title="${escapeAttr(gs.dirty)} uncommitted file${gs.dirty !== 1 ? 's' : ''}">●${gs.dirty}</span>`);
    return parts.join(' ');
}

export function _repoBranch(repoName, branch) {
    if (repoName && branch) return `${repoName} : ${branch}`;
    return branch || repoName || '';
}

export function _shortPath(fullPath, segments = 2) {
    if (!fullPath) return '';
    let p = fullPath.replace(/\/+$/, '');
    // Try to replace common home dir with tilde
    p = p.replace(/^\/Users\/[^\/]+/, '~').replace(/^\/home\/[^\/]+/, '~');
    const parts = p.split('/');
    if (parts.length <= segments) return p;
    return '…/' + parts.slice(-segments).join('/');
}

/** board_unread as a safe, finite, non-negative integer (payloads are untrusted input to markup). */
 export function sessionUnreadCount(s) {
    const n = Number(s && s.board_unread);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
