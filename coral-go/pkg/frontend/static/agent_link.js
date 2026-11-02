/* One way to show an agent's name wherever the app shows one (#12168, the operator: "make that a common thing throughout Coral"): the name as written (never lower-cased, hidden characters written out),
 * and, when that agent is running, a button that opens its chat on its own computer; an agent that is gone is plain text with a tooltip saying so. Used by comment authors and avatars, the "Sent to" line, and the
 * conversions listed in tests/frontend/agent_name_sites.json (a census fails when a converted site stops using it). Never builds HTML: every name is set as text. */
import { markHidden } from './visible_marks.js';
import { liveAgentOf, markAgent } from './agent_live.js';
import { loadStyles } from './lazy_styles.js';
import { escapeHtml, escapeAttr } from './utils.js';

await loadStyles('agent_link.css'); // not at start (page_weight): the helper's few rules load with it

/** The name, as a button that opens the agent's chat when it is running, as plain text with a tooltip when it is not. `board` is the team's key, `session` the agent's session id when the caller has it. */
export function agentLink(name, { board = '', session = '', cls = '', label = '', text = '' } = {}) {
    const shown = markHidden(String(text || name || ''), { strict: true }).trim() || 'unknown'; // text: what to show when it differs from the name looked up ("Orchestrator (dev team)")
    const live = liveAgentOf(name, { board, session });
    if (!live) { const t = document.createElement('span'); t.className = `agent-name${cls ? ' ' + cls : ''}`; t.textContent = shown; t.title = `${shown} is not running`; return t; }
    const b = document.createElement('button'); b.type = 'button'; b.className = `agent-name agent-link${cls ? ' ' + cls : ''}`; b.textContent = shown;
    b.setAttribute('aria-label', label || `Open ${shown}`); b.title = `Open ${shown}`; b.dataset.agentLink = live.session_id || '';
    return b;
}

/** agentLink as markup, for the places that build a string (the Board's messages): every part escaped here. */
export function agentLinkHtml(name, { board = '', session = '', cls = '', text = '' } = {}) {
    const shown = markHidden(String(text || name || ''), { strict: true }).trim() || 'unknown', live = liveAgentOf(name, { board, session }), c = cls ? ' ' + escapeAttr(cls) : '';
    return live
        ? `<button type="button" class="agent-name agent-link${c}" data-agent-link="${escapeAttr(live.session_id || '')}" aria-label="Open ${escapeAttr(shown)}" title="Open ${escapeAttr(shown)}">${escapeHtml(shown)}</button>`
        : `<span class="agent-name${c}" title="${escapeAttr(shown)} is not running">${escapeHtml(shown)}</span>`;
}

/** Make an existing decoration (an avatar circle) open the same chat on a click: a mouse convenience, since the name beside it is the one real button. Does nothing for an agent that is gone. */
export function linkAvatar(el, name, opts = {}) {
    if (markAgent(el, name, opts)) el.classList.add('agent-link-avatar');
    return el;
}

export { liveAgentOf };
