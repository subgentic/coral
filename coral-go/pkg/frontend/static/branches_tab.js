/* The Branches tab (goal #11): the worktrees of the repository the agent works in, and on a team's page those of every repository its agents work in. Read-only, from the git poller's snapshot
 * (GET .../branches, GET /api/board/<team>/branches: no git runs for this page). Every text from the repository or GitHub (a branch name, the base, the remote) is set with textContent;
 * nothing is a link, and no folder path is shown. A tab reads only while it is open. */
import { state } from './state.js';
import { serverFetch, serverForSession, boardFetch } from './server_base.js';
import { emptyState } from './dom_write.js';

const REFRESH_MS = 60000; // the snapshot is read again at most once a minute on the server
const FIRST_READ_STEPS = [2000, 4000, 8000, 15000]; // a repository is first read when the tab asks (the server starts a pass then): look again soon, then less often
const FIRST_READ_MS = 15000; // the team's page asks again this soon while none of its repositories is read
const FIRST_READ_LIMIT_MS = 60000; // past this with nothing read, the tab says so instead of 'reading'
let waiting = { session: '', since: 0, tries: 0 }; // how long the open agent's repository has been asked for without an answer
let generation = 0;
let timer = null;
const panel = () => document.getElementById('agentic-panel-branches');

/** Reads and draws the agent's open tab; does nothing while it is not the open one. */
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
    const notYet = !!data && data.available !== false && !data.found;
    if (!notYet) waiting = { session: '', since: 0, tries: 0 };
    else if (waiting.session !== s.session_id) waiting = { session: s.session_id, since: Date.now(), tries: 0 };
    const overdue = notYet && Date.now() - waiting.since > FIRST_READ_LIMIT_MS;
    if (!data || data.available === false) emptyState(el, 'Branches are not available from this computer.');
    else if (!data.found) emptyState(el, waitingText(overdue));
    else el.replaceChildren(drawRepo(data, s.session_id));
    // past the limit the folder is likely not a repository: ask once a minute, so an open tab on it does not start a pass every 15 s (Security's INFO on #531)
    timer = setTimeout(loadBranches, notYet && !overdue ? FIRST_READ_STEPS[Math.min(waiting.tries++, FIRST_READ_STEPS.length - 1)] : REFRESH_MS);
}

let teamTimer = null;
let teamSeq = 0;
let teamWaiting = { team: '', since: 0 }; // how long the team's page has asked without a repository read

/** The team page's Branches tab: every repository the team's agents work in, one section each. Reads again every minute while host is on the page. */
export async function showTeamBranches(host, team) {
    clearTimeout(teamTimer);
    const mine = ++teamSeq;
    let data = null;
    try {
        const resp = await boardFetch(team, '/branches');
        if (resp.ok) data = await resp.json();
    } catch { /* drawn as unavailable below */ }
    if (mine !== teamSeq || !host.isConnected) return; // another team or tab was opened meanwhile
    if (!data || data.available === false) emptyState(host, 'Branches are not available from this computer.');
    const none = !!data && data.available !== false && !(data.repos || []).length;
    if (!none) teamWaiting = { team: '', since: 0 };
    else if (teamWaiting.team !== team) teamWaiting = { team, since: Date.now() };
    const overdue = none && Date.now() - teamWaiting.since > FIRST_READ_LIMIT_MS;
    if (!data || data.available === false) emptyState(host, 'Branches are not available from this computer.');
    else if (none) emptyState(host, overdue
        ? "Coral has not read a repository for this team's agents. Their folders may not be in git repositories, or a slow read is paused for a few minutes."
        : "Reading the repositories this team's agents work in: the first read takes a few seconds.");
    else host.replaceChildren(...data.repos.map(r => drawRepo(r, '')));
    // past the limit, ask once a minute like the agent's tab, so a page left open on folders that are not repositories does not start a pass every 15 s (Security's INFO on #531)
    teamTimer = setTimeout(() => { if (host.isConnected && host.offsetParent !== null) showTeamBranches(host, team); }, none && !overdue ? FIRST_READ_MS : REFRESH_MS);
}

function text(tag, className, value) {
    const e = document.createElement(tag);
    e.className = className;
    e.textContent = value;
    return e;
}

/** A worktree's changed files, as words: not read at all when it is not on a local drive, and "not counted" (not 0) when the untracked scan did not finish. */
function changes(w) {
    if (w.not_local) return 'not on a local drive: not read';
    if (w.unreadable) return 'changes not readable';
    const untracked = w.untracked_unknown ? 'untracked not counted' : `${w.untracked}${w.untracked_more ? '+' : ''} untracked`;
    return `${w.changed} changed, ${untracked}`;
}

/** The numbers of one worktree, as words. */
function numbers(w, base) {
    if (!base) return changes(w);
    if (w.is_base) return `the base branch · ${changes(w)}`;
    const where = (w.ahead || w.behind) ? `${w.ahead} ahead, ${w.behind} behind` : 'even with the base';
    return `${where} · ${changes(w)}`;
}

/** What the tab says while its repository has not been read: the first read takes seconds (the tab's ask starts a pass on the server); past a minute it says it has not read one. */
function waitingText(overdue) {
    return overdue
        ? "Coral has not read a repository for this agent's folder. Its folder may not be in a git repository, or git took too long and the read is paused for a few minutes."
        : "Reading this agent's repository: the first read takes a few seconds.";
}

const PR_STATE = { open: 'open', merged: 'merged', closed: 'closed' };
const PR_CHECKS = { passing: 'checks passing', failing: 'checks failing', pending: 'checks running' };
const PR_REVIEW = { approved: 'approved', changes_requested: 'changes requested', review_required: 'review required' };

/** A worktree's PR as one line of words: its number, state, checks and review; never a link. */
function prLine(pr) {
    const parts = [`PR #${pr.number}`, pr.draft && pr.state === 'open' ? 'draft' : (PR_STATE[pr.state] || '')];
    if (PR_CHECKS[pr.checks]) parts.push(PR_CHECKS[pr.checks]);
    if (PR_REVIEW[pr.review]) parts.push(PR_REVIEW[pr.review]);
    return parts.filter(Boolean).join(' · ');
}

/** One repository's section: its remote and base, then a row per worktree. currentSid marks the asking agent's own worktree ('' on the team's page). */
function drawRepo(data, currentSid) {
    const box = document.createElement('section');
    box.className = 'branches-repo';
    if (data.remote) box.append(text('h3', 'branches-remote', `${data.remote.host}/${data.remote.owner}/${data.remote.name}`));
    else if (data.remote_unknown) box.append(text('h3', 'branches-remote', 'unknown remote'));
    if (data.unreadable) { box.append(text('p', 'branches-note', 'Coral could not read this repository.')); return box; }
    box.append(text('p', 'branches-note', data.base ? `Counted against ${data.base}.` : 'No base branch found: counts are not shown.'));
    if (data.pr_note) box.append(text('p', 'branches-note', data.pr_note));
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
        row.append(title, text('div', 'branches-meta', numbers(w, data.base)));
        const marks = [];
        if (w.nothing_to_merge) marks.push('no commits left to merge');
        if (w.upstream_gone) marks.push('upstream branch deleted');
        if (w.quiet) marks.push('no commit in 14 days');
        if (marks.length) row.append(text('div', 'branches-mark', marks.join(' · ')));
        if (w.pr) row.append(text('div', 'branches-meta', prLine(w.pr)));
        const agents = (w.agents || []).filter(a => !currentSid || a.session_id !== currentSid).map(a => a.display_name || a.name);
        if (agents.length) row.append(text('div', 'branches-meta', `${currentSid ? 'Agents here' : 'Agents'}: ${agents.join(', ')}`));
        if (w.current && w.changed) row.append(text('div', 'branches-meta', 'The Files tab lists the changes.'));
        list.append(row);
    }
    box.append(list);
    if (data.more) box.append(text('p', 'branches-note', `${data.more} more worktrees are not shown.`));
    return box;
}
