/* The Branches tab (goal #11): the worktrees of the repository the agent works in, and on a team's page those of every repository its agents work in. Read-only, from the git poller's snapshot
 * (GET .../branches, GET /api/board/<team>/branches: no git runs for this page). Every text from the repository or GitHub (a branch name, the base, the remote) is set with textContent;
 * nothing is a link, and no folder path is shown. A tab reads only while it is open. */
import { importOnce } from './import_once.js';
import { state } from './state.js';
import { serverFetch, serverForSession, boardFetch, splitKey } from './server_base.js';
import { emptyState } from './dom_write.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('branches.css'); // the tab's rules load with it, not at start (#17746)

const REFRESH_MS = 60000; // the snapshot is read again at most once a minute on the server
const FIRST_READ_STEPS = [2000, 4000, 8000, 15000]; // a repository is first read when the tab asks (the server starts a pass then): look again soon, then less often
const FIRST_READ_MS = 15000; // the team's page asks again this soon while none of its repositories is read
const FIRST_READ_LIMIT_MS = 60000; // past this with nothing read, the tab says so instead of 'reading'
let waiting = { session: '', since: 0, tries: 0 }; // how long the open agent's repository has been asked for without an answer
let generation = 0;
let timer = null;
const NOT_GIT_AGENT = "This agent's folder is not a git repository, so there are no branches to show. To see them, run git init in that folder, or start the agent in a folder that is a repository.";
const NOT_GIT_TEAM = "None of this team's agents works in a git repository, so there are no branches to show. To see them, run git init in an agent's folder, or start an agent in a folder that is a repository.";
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
    const notGit = !!data && data.available !== false && !data.found && data.not_git === true; // no .git in the folder or above it: said at once, with the next step (#17483)
    const notYet = !!data && data.available !== false && !data.found && !notGit;
    if (!notYet) waiting = { session: '', since: 0, tries: 0 };
    else if (waiting.session !== s.session_id) waiting = { session: s.session_id, since: Date.now(), tries: 0 };
    const overdue = notYet && Date.now() - waiting.since > FIRST_READ_LIMIT_MS;
    if (!data || data.available === false) emptyState(el, 'Branches are not available from this computer.');
    else if (notGit) emptyState(el, NOT_GIT_AGENT);
    else if (!data.found) emptyState(el, waitingText(overdue, waiting.since));
    else el.replaceChildren(drawRepo(data, s.session_id, { name: s.name, session_id: s.session_id, agent_type: s.agent_type || '' }, s.board_project || '', serverForSession(s.name, s.session_id)));
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
    const notGit = !!data && data.available !== false && !(data.repos || []).length && data.not_git === true;
    const none = !!data && data.available !== false && !(data.repos || []).length && !notGit;
    if (!none) teamWaiting = { team: '', since: 0 };
    else if (teamWaiting.team !== team) teamWaiting = { team, since: Date.now() };
    const overdue = none && Date.now() - teamWaiting.since > FIRST_READ_LIMIT_MS;
    if (!data || data.available === false) emptyState(host, 'Branches are not available from this computer.');
    else if (notGit) emptyState(host, NOT_GIT_TEAM);
    else if (none) emptyState(host, overdue
        ? "Coral has not read a repository for this team's agents. Their folders may not be in git repositories, or a slow read is paused for a few minutes."
        : `Reading the repositories this team's agents work in${Math.round((Date.now() - teamWaiting.since) / 1000) >= 5 ? `, ${Math.round((Date.now() - teamWaiting.since) / 1000)} s so far` : ''}: the first read takes a few seconds, and a large repository can take a minute.`);
    else host.replaceChildren(...data.repos.map(r => drawRepo(r, '', r.ask, splitKey(team).name, splitKey(team).server)));
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
    if (!base) {
        const count = w.commit_count;
        const history = w.not_local ? 'Commit history not counted for this folder' : Number.isInteger(count) && count >= 0
            ? `${count > 1000 ? '1000+' : count} ${count === 1 ? 'commit' : 'commits'} in branch history`
            : '';
        return [history, changes(w)].filter(Boolean).join(' · ');
    }
    if (w.is_base) return `the base branch · ${changes(w)}`;
    const where = (w.ahead || w.behind) ? `${w.ahead} ahead, ${w.behind} behind` : 'even with the base';
    return `${where} · ${changes(w)}`;
}

/** What the tab says while its repository has not been read: the first read takes seconds (the tab's ask starts a pass on the server); past a minute it says it has not read one. */
function waitingText(overdue, since = 0) {
    const secs = since ? Math.round((Date.now() - since) / 1000) : 0; // the cause and the time so far, not a silent 'reading' (#17433)
    return overdue
        ? "Coral has not read a repository for this agent's folder. Its folder may not be in a git repository, or git took too long and the read is paused for a few minutes."
        : `Reading this agent's repository${secs >= 5 ? `, ${secs} s so far` : ''}: the first read takes a few seconds, and a large repository can take a minute.`;
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

/** A branch's detail: the commits it has over the base and the files they change, read when the row's button is pressed (GET .../branches/detail), set with textContent only (#17543).
 * The author is what git records, the machine's git user: Coral does not know which agent made a commit, so the agents working in the branch are named on the row. */
function detailToggle(ask, w, base) {
    const wrap = document.createElement('div');
    wrap.className = 'branches-detail';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'branches-more'; btn.textContent = 'Show commits and files'; btn.setAttribute('aria-expanded', 'false');
    const body = document.createElement('div');
    body.className = 'branches-detail-body'; body.hidden = true; body.setAttribute('role', 'region'); body.setAttribute('aria-label', 'Commits and files of this branch');
    let loaded = false;
    btn.addEventListener('click', async () => {
        const open = body.hidden;
        body.hidden = !open; btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'Hide commits and files' : 'Show commits and files';
        if (!open || loaded) return;
        body.replaceChildren(text('div', 'branches-meta', 'Reading the branch...'));
        let d = null, failed = '';
        try {
            const qs = new URLSearchParams({ session_id: ask.session_id || '', agent_type: ask.agent_type || '', head: w.head });
            const resp = await serverFetch(serverForSession(ask.name, ask.session_id), `/api/sessions/live/${encodeURIComponent(ask.name)}/branches/detail?${qs}`);
            if (resp.ok) d = await resp.json(); else if (resp.status === 404) failed = 'This branch has moved since the last read. Close this and open it again in a minute.';
        } catch { /* said below */ }
        if (!d) { body.replaceChildren(text('div', 'branches-meta', failed || 'Could not read this branch. Close this and open it again to retry.')); return; }
        loaded = true;
        const parts = [];
        parts.push(text('div', 'branches-meta', d.commits.length ? `${d.commits.length}${d.more_commits ? '+' : ''} ${d.commits.length === 1 && !d.more_commits ? 'commit' : 'commits'} over ${base}:` : `No commits over ${base}.`));
        const log = document.createElement('ul'); log.className = 'branches-commits';
        for (const c of d.commits) { const li = document.createElement('li'); li.append(text('span', 'branches-sha', c.id.slice(0, 7)), ' ', c.subject, ' ', text('span', 'branches-mark', `${c.author}${c.at ? ' · ' + new Date(c.at).toLocaleDateString() : ''}`)); log.append(li); }
        if (d.commits.length) parts.push(log);
        if (d.files.length) {
            parts.push(text('div', 'branches-meta', `${d.files.length}${d.more_files ? '+' : ''} ${d.files.length === 1 && !d.more_files ? 'file' : 'files'} changed:`));
            const fl = document.createElement('ul'); fl.className = 'branches-commits';
            for (const f of d.files) { const li = document.createElement('li'); li.append(text('span', 'branches-sha', f.path), ' ', text('span', 'branches-mark', f.binary ? 'binary' : `+${f.added} −${f.removed}`)); fl.append(li); }
            parts.push(fl);
        }
        body.replaceChildren(...parts);
    });
    wrap.append(btn, body);
    return wrap;
}

/** One repository's section: its remote and base, then a row per worktree. currentSid marks the asking agent's own worktree ('' on the team's page). */
function drawRepo(data, currentSid, ask, team, server) {
    const box = document.createElement('section');
    box.className = 'branches-repo';
    if (data.remote) box.append(text('h3', 'branches-remote', `${data.remote.host}/${data.remote.owner}/${data.remote.name}`));
    else if (data.remote_unknown) box.append(text('h3', 'branches-remote', 'unknown remote'));
    if (data.unreadable) { box.append(text('p', 'branches-note', 'Coral could not read this repository.')); return box; }
    box.append(text('p', 'branches-note', data.base ? `Counted against ${data.base}.` : 'No comparison branch found. Saved commits and uncommitted files are shown below.'));
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
        if (w.main) title.append(' ', text('span', 'branches-mark', 'original folder'));
        row.append(title);
        const members = [...(w.agents || [])];
        if (w.current && !members.some(a => a.session_id === currentSid) && state.currentSession?.session_id === currentSid) members.unshift(state.currentSession);
        const detail = text(members.length ? 'button' : 'div', members.length ? 'btn btn-small branches-changes' : 'branches-meta', numbers(w, data.base));
        if (!data.base && !w.not_local && Number.isInteger(w.commit_count) && w.commit_count >= 0) detail.title = 'Includes commits inherited from earlier branches.';
        if (members.length) {
            detail.type = 'button'; detail.setAttribute('aria-label', `View changes on ${name}: ${numbers(w, data.base)}`);
            detail.addEventListener('click', async () => {
                detail.disabled = true;
                try { const m = await importOnce('./branch_changes.js'); m.openBranchChanges(w, members, team, server); }
                catch { detail.textContent = 'Could not open changes. Try again.'; }
                finally { detail.disabled = false; }
            });
        }
        row.append(detail);
        const marks = [];
        if (w.nothing_to_merge) marks.push('no commits left to merge');
        if (w.upstream_gone) marks.push('upstream branch deleted');
        if (w.quiet) marks.push('no commit in 14 days');
        if (marks.length) row.append(text('div', 'branches-mark', marks.join(' · ')));
        if (w.pr) row.append(text('div', 'branches-meta', prLine(w.pr)));
        const agents = (w.agents || []).filter(a => !currentSid || a.session_id !== currentSid).map(a => a.display_name || a.name);
        if (agents.length) row.append(text('div', 'branches-meta', `${currentSid ? 'Agents here' : 'Agents'}: ${agents.join(', ')}`));
        if (w.current && w.changed) row.append(text('div', 'branches-meta', 'The Files tab lists the changes.'));
        if (ask && data.base && w.head && !w.not_local && !w.unreadable) row.append(detailToggle(ask, w, data.base));
        list.append(row);
    }
    box.append(list);
    if (data.more) box.append(text('p', 'branches-note', `${data.more} more worktrees are not shown.`));
    return box;
}
