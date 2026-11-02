/* Which running agent a name belongs to, and the one click that opens its chat (#12197). Small and safe at start (no styles, no top-level await): data_table.js marks its people circles with it at once, and agent_link.js
 * (the lazy helper that draws names as links) builds on it. A name that is not a running agent is left alone. */
import { state } from './state.js';
import { importOnce } from './import_once.js';
import { sessionServer, splitKey } from './server_base.js';
import { markHidden } from './visible_marks.js';
import { escapeHtml, escapeAttr } from './utils.js';

/** The running agent a board role name belongs to: the live session whose board role is `name` (any case) on `board` when one is given, or the session id `session`. */
export function liveAgentOf(name, { board = '', session = '' } = {}) {
    const rows = state.liveSessions || [];
    if (session) { const hit = rows.find(s => s.session_id === session); if (hit) return hit; }
    const want = String(name || '').trim().toLowerCase(); if (!want) return null;
    const team = board ? splitKey(board).name : '';
    return rows.find(s => !s.archived && String(s.board_subscriber_id || '').trim().toLowerCase() === want && (!team || String(s.board_project || '') === team || String(s.board_project || '') === board)) || null;
}

// The file viewer (a modal div) or a native dialog the name sat in is closed first, so the chat is not opened behind it (#12168).
const closeOverlays = () => {
    document.querySelector('#artifact-viewer:not([hidden]) [data-dialog-close], #artifact-viewer:not([hidden]) .artifact-viewer-close')?.click();
    for (const d of document.querySelectorAll('dialog[open]')) { try { d.close(); } catch { /* already closing */ } }
};
// Words typed into a dialog that is about to close (a question's reply box): closing it would drop them, so the person is asked first (#12299).
const typedInOverlay = () => [...document.querySelectorAll('dialog[open], #artifact-viewer:not([hidden])')].some(d => [...d.querySelectorAll('textarea, input[type=text], input[type=search], input:not([type])')].some(f => !f.readOnly && !f.disabled && f.value.trim() && f.value !== f.defaultValue));
// The question is its own native dialog, shown modally, so it stacks in front of the dialog the name sat in (the shared confirm is a div, which a native modal covers).
const askLeave = async go => {
    const { loadStyles } = await importOnce('./lazy_styles.js'); await loadStyles('agent_link.css'); // the dialog's few rules are in the lazy sheet, not the start CSS (page_weight)
    const d = document.createElement('dialog'); d.className = 'dlg-confirm agent-leave-ask'; d.setAttribute('aria-labelledby', 'agent-leave-title');
    const h = document.createElement('h2'); h.id = 'agent-leave-title'; h.textContent = 'Leave this dialog?';
    const p = document.createElement('p'); p.textContent = 'What you typed here is not sent and will be lost.';
    const row = document.createElement('div'); row.className = 'modal-actions';
    const stay = document.createElement('button'); stay.type = 'button'; stay.className = 'btn'; stay.textContent = 'Cancel'; stay.dataset.dialogClose = '';
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn btn-primary'; yes.textContent = 'Open chat'; yes.dataset.agentLeaveYes = '';
    row.append(stay, yes); d.append(h, p, row);
    stay.addEventListener('click', () => d.close());
    yes.addEventListener('click', () => { d.close(); go(); });
    d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal(); stay.focus();
};
export const openAgent = s => {
    const go = () => { closeOverlays(); window.switchNavTab?.('agents'); Promise.resolve(window.selectLiveSession?.(s.name, s.agent_type, s.session_id || '', sessionServer(s))).catch(() => {}); };
    if (typedInOverlay()) askLeave(go); else go();
};

// One delegated click for every link and circle that carries data-agent-link, DOM or HTML: in the capture phase and stopped, so a row or card the name sits in does not also open its own page.
document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target.closest('[data-agent-link]') : null; if (!t || !t.dataset.agentLink) return;
    const live = (state.liveSessions || []).find(s => s.session_id === t.dataset.agentLink); if (!live) return;
    e.stopPropagation(); e.preventDefault(); openAgent(live);
}, true);

/** Make `el` open the agent's chat on a click when `name` is a running agent (a person's circle or name in a table); returns whether it did. */
export function markAgent(el, name, opts = {}) {
    const live = liveAgentOf(name, opts); if (!live) return false;
    el.dataset.agentLink = live.session_id || ''; el.style.cursor = 'pointer'; el.title = el.title || `Open ${String(name).trim()}`;
    return true;
}

/** An agent's name as text (hidden characters written out, the case as written) that opens its chat on a click when it is running: for a table cell or a detail line, where the lazy link helper is not worth loading. */
export function nameSpan(name, opts = {}) {
    const sp = document.createElement('span'), shown = markHidden(String(name || ''), { strict: true }).trim();
    sp.textContent = shown || '\u2014'; if (shown) markAgent(sp, name, opts);
    return sp;
}

/** nameSpan as markup, for a block built as a string (a task's page): every part escaped here. */
export function agentNameHtml(name, opts = {}) {
    const shown = markHidden(String(name || ''), { strict: true }).trim(), live = shown ? liveAgentOf(name, opts) : null;
    if (!shown) return '\u2014';
    return live ? `<span class="agent-name" data-agent-link="${escapeAttr(live.session_id || '')}" style="cursor:pointer" title="Open ${escapeAttr(shown)}">${escapeHtml(shown)}</span>` : escapeHtml(shown);
}
