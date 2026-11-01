/* The Branches tab (goal #11): the worktrees of the repository the agent works in, read-only, from GET .../branches, which reads the git poller's snapshot (no git runs for this page).
 * Every text that comes from the repository (a branch name, the base) is set with textContent; nothing is a link, and no folder path is shown. The tab reads only while it is open. */
import { state } from './state.js';
import { serverFetch, serverForSession } from './server_base.js';
import { emptyState } from './dom_write.js';

const REFRESH_MS = 60000; // the snapshot is read again at most once a minute on the server
let generation = 0;
let timer = null;
const panel = () => document.getElementById('agentic-panel-branches');

/** Reads and draws the open tab; does nothing while it is not the open one. */
export async function loadBranches() {
    const el = panel();
    clearTimeout(timer);
    if (!el || !el.classList.contains('active')) return;
    const s = state.currentSession;
    if (!s || s.type !== 'live' || !s.name) { emptyState(el, 'Branches show for a live agent.'); return; }
    const mine = ++generation;
    let data = null;
    try {
        const qs = new URLSearchParams({ session_id: s.session_id || '', agent_type: s.agent_type || '' });
        const resp = await serverFetch(serverForSession(s.name, s.session_id), `/api/sessions/live/${encodeURIComponent(s.name)}/branches?${qs}`);
        if (resp.ok) data = await resp.json();
    } catch { /* drawn as unavailable below */ }
    if (mine !== generation || state.currentSession?.session_id !== s.session_id) return; // another agent was chosen meanwhile
    draw(el, data);
    timer = setTimeout(loadBranches, REFRESH_MS);
}

function text(tag, className, value) {
    const e = document.createElement(tag);
    e.className = className;
    e.textContent = value;
    return e;
}

/** The numbers of one worktree, as words. */
function numbers(w) {
    const parts = [];
    if (w.ahead || w.behind) parts.push(`${w.ahead} ahead, ${w.behind} behind`);
    else parts.push('even with the base');
    if (w.unreadable) parts.push('changes not readable');
    else parts.push(`${w.changed} changed, ${w.untracked}${w.untracked_more ? '+' : ''} untracked`);
    return parts.join(' · ');
}

function draw(el, data) {
    if (!data || data.available === false) { emptyState(el, 'Branches are not available from this computer.'); return; }
    if (!data.found) { emptyState(el, "This agent's folder is not in a git repository Coral reads."); return; }
    if (data.unreadable) { emptyState(el, 'Coral could not read this repository.'); return; }
    const head = text('p', 'branches-note', data.base ? `Counted against ${data.base}.` : 'No base branch found: counts are not shown.');
    const list = document.createElement('ul');
    list.className = 'branches-list';
    for (const w of data.worktrees || []) {
        const row = document.createElement('li');
        row.className = 'branches-row';
        if (w.current) row.setAttribute('aria-current', 'true');
        const name = w.name_hidden ? 'a branch whose name has hidden characters' : (w.detached || !w.branch ? `detached at ${w.head}` : w.branch);
        const title = text('div', 'branches-name', name);
        if (w.current) title.append(' ', text('span', 'branches-mark', 'this agent'));
        if (w.main) title.append(' ', text('span', 'branches-mark', 'main worktree'));
        row.append(title);
        if (data.base) row.append(text('div', 'branches-meta', numbers(w)));
        else row.append(text('div', 'branches-meta', w.unreadable ? 'changes not readable' : `${w.changed} changed, ${w.untracked}${w.untracked_more ? '+' : ''} untracked`));
        if (w.nothing_to_merge) row.append(text('div', 'branches-mark', 'no commits left to merge'));
        const others = (w.agents || []).filter(a => !w.current || a.session_id !== state.currentSession?.session_id).map(a => a.name);
        if (others.length) row.append(text('div', 'branches-meta', `Agents here: ${others.join(', ')}`));
        if (w.current && w.changed) row.append(text('div', 'branches-meta', 'The Files tab lists the changes.'));
        list.append(row);
    }
    el.replaceChildren(head, list);
    if (data.more) el.append(text('p', 'branches-note', `${data.more} more worktrees are not shown.`));
}
