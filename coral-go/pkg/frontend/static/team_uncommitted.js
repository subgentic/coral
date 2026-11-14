/* The team page's line about work an agent left uncommitted (#17203): "Files changed in <folder>, not committed: N changed, M new" with Review changes (the list) and Commit (one local commit, never pushed). Lazy, loaded by the team page. */
import { teamFetch, boardFetch, splitKey } from './server_base.js';

const $ = (id) => document.getElementById(id);
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let seq = 0;

const countWords = (r) => [r.changed ? `${r.changed} changed` : '', r.new ? `${r.new} new` : ''].filter(Boolean).join(', ');

/** Reads the team's folders and draws one line per folder with work not committed; none draws nothing. */
export async function refreshUncommitted(team) {
    const box = $('team-page-uncommitted'); if (!box) return;
    const mine = ++seq;
    let repos = [];
    try {
        const r = await teamFetch(team, (n) => `/api/teams/detail/${encodeURIComponent(n)}/uncommitted`, { cache: 'no-store' });
        if (r.ok) repos = ((await r.json()) || {}).repos || [];
    } catch { /* offline: the line stays as it was */ return; }
    if (mine !== seq) return;
    box.replaceChildren(...repos.map((repo) => drawRepo(team, repo)));
    box.hidden = !repos.length;
}

async function goalTitle(team) {
    try {
        const r = await boardFetch(team, '/goals?state=active&limit=1');
        const d = r.ok ? await r.json() : null;
        const g = (Array.isArray(d) ? d : (d && d.goals) || [])[0];
        return g && g.title ? String(g.title) : '';
    } catch { return ''; }
}

function drawRepo(team, repo) {
    const row = mk('div', 'team-uncommitted-row');
    const folderName = repo.folder.split(/[\\/]/).filter(Boolean).pop() || repo.folder;
    const line = mk('div', 'team-uncommitted-line');
    const words = mk('span', 'team-uncommitted-words', `Files changed in ${folderName}, not committed: ${countWords(repo)}${repo.truncated ? ' or more' : ''}`);
    words.title = repo.folder;
    const review = mk('button', 'btn team-uncommitted-review', 'Review changes'); review.type = 'button'; review.setAttribute('aria-expanded', 'false');
    const commit = mk('button', 'btn btn-primary team-uncommitted-commit', 'Commit'); commit.type = 'button';
    line.append(words, review, commit);
    const list = mk('ul', 'team-uncommitted-files'); list.hidden = true;
    for (const f of repo.files) list.append(mk('li', 'team-uncommitted-file', `${f.status === 'new' ? 'new' : 'changed'}  ${f.path}`));
    const form = mk('div', 'team-uncommitted-form'); form.hidden = true;
    row.append(line, list, form);
    review.addEventListener('click', () => { list.hidden = !list.hidden; review.setAttribute('aria-expanded', String(!list.hidden)); });
    commit.addEventListener('click', async () => {
        if (!form.hidden) { form.hidden = true; return; }
        form.hidden = false;
        buildForm(team, repo, form, commit, await goalTitle(team));
    });
    return row;
}

function buildForm(team, repo, form, commitBtn, title) {
    form.replaceChildren();
    const label = mk('label', 'team-uncommitted-label', 'Commit message');
    const msg = mk('textarea', 'team-uncommitted-message'); msg.rows = 2; msg.value = title || `Work from ${splitKey(team).name}`;
    label.append(msg);
    form.append(label);
    let tick = null;
    if (repo.secret_like && repo.secret_like.length) {
        const w = mk('label', 'team-uncommitted-secret');
        tick = mk('input'); tick.type = 'checkbox';
        w.append(tick, ` These files look like secrets and are left out: ${repo.secret_like.join(', ')}. Include them`);
        form.append(w);
    }
    form.append(mk('p', 'team-uncommitted-note', repo.signing ? 'Unsigned local commit (your git settings ask for signing; Coral does not sign); git hooks are not run. Nothing is pushed.' : 'Unsigned local commit; git hooks are not run. Nothing is pushed.'));
    const out = mk('pre', 'team-uncommitted-output'); out.hidden = true;
    const err = mk('p', 'team-uncommitted-error'); err.hidden = true; err.setAttribute('role', 'alert');
    const go = mk('button', 'btn btn-primary team-uncommitted-go', 'Commit'); go.type = 'button';
    const cancel = mk('button', 'btn team-uncommitted-cancel', 'Cancel'); cancel.type = 'button';
    const acts = mk('div', 'team-uncommitted-acts'); acts.append(go, cancel);
    form.append(err, out, acts);
    cancel.addEventListener('click', () => { form.hidden = true; commitBtn.focus(); });
    go.addEventListener('click', async () => {
        const message = msg.value.trim();
        if (!message) { msg.focus(); return; }
        go.disabled = true; err.hidden = true; out.hidden = true;
        try {
            const r = await teamFetch(team, (n) => `/api/teams/detail/${encodeURIComponent(n)}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: repo.folder, message, include_secret_like: !!(tick && tick.checked) }) });
            const d = await r.json().catch(() => ({}));
            if (r.ok) { form.hidden = true; refreshUncommitted(team); return; }
            err.textContent = d.error || 'The commit did not happen.'; err.hidden = false;
            if (d.output) { out.textContent = d.output; out.hidden = false; }
        } catch { err.textContent = 'The commit did not happen: Coral could not be reached.'; err.hidden = false; }
        go.disabled = false;
    });
}
