/* A killed agent's row says Stopping... at once (#15370, user feedback): the kill call can take seconds (the agent's terminal, its worktree), and a row that looks untouched reads as a click that did not register. Rows are marked in place, wherever the agent is
 * listed (the sidebar, the Agents page, a team's list), dimmed with their actions off; the lists are redrawn by polls and pushes, so a watcher puts the mark back on a redrawn row until the kill ends. A failed kill takes it off. Loaded on demand with the first kill. */
import { loadStyles } from './lazy_styles.js';
import { serverFetch, sessionServer } from './server_base.js';
await loadStyles('kill_pending.css');

const pending = new Set();
let watcher = null, applying = false;

function apply() {
    if (applying) return;
    applying = true;
    try {
        for (const id of pending) {
            for (const row of document.querySelectorAll(`[data-session-id="${CSS.escape(id)}"]`)) {
                if (row.classList.contains('agent-stopping')) continue;
                row.classList.add('agent-stopping'); row.setAttribute('aria-busy', 'true');
                const note = document.createElement('span'); note.className = 'agent-stopping-note'; note.setAttribute('role', 'status'); note.textContent = 'Stopping…';
                row.append(note);
            }
        }
    } finally { applying = false; }
}
function clearMarks(id) {
    for (const row of document.querySelectorAll(`[data-session-id="${CSS.escape(id)}"].agent-stopping`)) {
        row.classList.remove('agent-stopping'); row.removeAttribute('aria-busy'); row.querySelectorAll(':scope > .agent-stopping-note').forEach(n => n.remove());
    }
}

/** The kill call, with the row saying Stopping... from the moment it is sent until it is answered (the first line of kill_live.js's doc says what it resolves to). A kill that failed or was refused takes the mark off; one that worked leaves it to the dropped row. */
export function killWithMark(row, server = sessionServer(row)) {
    const call = serverFetch(server, `/api/sessions/live/${encodeURIComponent(row.name)}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_type: row.agent_type, session_id: row.session_id }),
    }).then(resp => resp.json().catch(() => null));
    const id = row.session_id;
    if (id) {
        pending.add(id);
        apply();
        if (!watcher) { watcher = new MutationObserver(() => apply()); watcher.observe(document.body, { childList: true, subtree: true }); }
        call.then(answer => { if (!answer || answer.error) clearStopping(id); else setTimeout(() => clearStopping(id), 3000); }, () => clearStopping(id));
    }
    return call;
}

/** Mark every row of a team or folder at once (Kill Team, Kill All: #15431), however long the call takes. Returns release(failedIds): the rows of agents whose kill failed lose the mark now (a team's call
 *  answers once, so all of them when it fails); the others keep it for the dropped row to replace, and lose it a moment later if the list still has them. */
export function markStopping(rows) {
    const ids = rows.map(r => r.session_id).filter(Boolean);
    for (const id of ids) pending.add(id);
    apply();
    if (ids.length && !watcher) { watcher = new MutationObserver(() => apply()); watcher.observe(document.body, { childList: true, subtree: true }); }
    return (failed = []) => {
        const bad = new Set(failed);
        for (const id of ids) { if (bad.has(id)) clearStopping(id); else setTimeout(() => clearStopping(id), 3000); }
    };
}

function clearStopping(sessionId) {
    pending.delete(sessionId);
    clearMarks(sessionId);
    if (!pending.size && watcher) { watcher.disconnect(); watcher = null; }
}
