/* The shared "Where" step of a launch (#20388, mock #20111), for New agent, New team and New terminal: the computer it runs on (with change), the recent repos on THAT computer with their branch and state, the branch it works on
 * (this folder as it is, a new worktree, a worktree that exists, another branch), and the setup check pinned above the footer: each item with a plain reason and, where there is one, the fix a click away. Everything is asked of the
 * computer the launch is for (through the per-computer routes: GET /api/launch/where and /api/launch/check, and cli-check for the agent's CLI), never of this one. Words from a computer are text, never markup.
 * What the person chose goes to the launch as wherePayload(kind): new_worktree {name, base, path} or checkout_branch, which the server turns into a worktree or a switch before the agent starts. */
import { importOnce } from './import_once.js';
import { serverFetch, isLocalServer, isCloud } from './server_base.js';
import { serverLabel } from './launch_server.js';
import { state } from './state.js';
import { loadStyles } from './lazy_styles.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer } = await importOnce('./launch_models.js');

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const MOUNTS = { agent: { input: 'launch-dir', after: 'agent-form-host' }, terminal: { input: 'launch-terminal-dir', after: null }, team: { input: 'launch-team-dir', after: 'team-form-host' } };
const shortPath = p => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
const tail = p => shortPath(p);
const randomName = () => `work-${Math.random().toString(16).slice(2, 6)}`;

let seq = 0;
const panels = {};
// the computer or the agent type changed: every open panel asks again (the folder is another computer's folder now)
if (typeof document !== 'undefined') document.addEventListener('change', e => { if (['launch-server', 'launch-type', 'team-agent-type'].includes(e.target?.id)) setTimeout(() => { for (const p of Object.values(panels)) if (p.host.isConnected) p.refresh(); }, 150); });

/** Words for the state of a folder: clean, changed, ahead, behind. */
export function stateTags(w) {
    const tags = [];
    if (w.clean === true) tags.push(['clean', 'ok']);
    else if (w.changed) tags.push([`${w.changed} changed`, 'warn']);
    if (w.ahead) tags.push([`${w.ahead} ahead`, 'info']);
    if (w.behind) tags.push([`${w.behind} behind`, 'warn']);
    return tags;
}

const tagNode = ([text, tone]) => node('span', `chip chip-tag launch-where-tag-${tone}`, text);

async function ask(server, path, query) {
    const r = await serverFetch(server, `${path}?${new URLSearchParams(query)}`);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
}

/** Mount the where panel for kind ('agent' | 'team' | 'terminal'); idempotent. Returns { refresh } or null when the step's field is not built yet. */
export async function mountLaunchWhere(kind) {
    const m = MOUNTS[kind], input = document.getElementById(m?.input);
    if (!m || !input) return null;
    if (panels[kind]?.host.isConnected) return panels[kind];
    await loadStyles('launch_where.css').catch(() => {});
    const host = node('section', 'launch-where'); host.dataset.launchWhere = kind; host.setAttribute('aria-label', 'Where it launches'); host.hidden = true;
    const row = input.closest('.form-row') || input.closest('.sv-row');
    const anchor = m.after ? document.getElementById(m.after) : row;
    if (!anchor) return null;
    anchor.after(host);
    const where = node('div', 'launch-where-computer'); where.dataset.launchWhereComputer = kind;
    (row || input).before(where); // the computer comes first: everything below is that computer's
    const p = panels[kind] = { host, kind, input, computer: where, choice: 'here', name: '', base: '', folder: '', folderEdited: false, other: '', existing: '', confirmCheckout: false, refresh: () => refresh(p) };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => refresh(p), 350); };
    input.addEventListener('input', later); input.addEventListener('change', later);
    refresh(p);
    return p;
}

const computerName = () => serverLabel(_effectiveServer(launch.server), state.servers);

/** The computer row: its name as a chip and a way to change it (the launch's own computer step). */
function drawComputer(p) {
    const here = computerName();
    const dot = node('span', 'launch-where-dot'); dot.setAttribute('aria-hidden', 'true');
    const chip = node('span', 'chip launch-where-computer-chip'); chip.append(dot, node('span', '', here));
    const change = node('button', 'btn-link launch-where-change', 'change'); change.type = 'button'; change.dataset.launchComputer = 'change'; change.setAttribute('aria-label', `Change the computer (now ${here})`);
    const labels = node('div', 'launch-where-labelrow'); labels.append(node('span', 'launch-where-label', 'Computer'), node('span', 'launch-where-hint', 'where it runs'));
    const line = node('div', 'launch-where-computer-line'); line.append(chip, change);
    p.computer.replaceChildren(labels, line);
    p.computer.hidden = p.kind === 'team'; // New team has its own computer line
}

async function refresh(p) {
    const mine = ++seq; p.seq = mine;
    drawComputer(p);
    const server = _effectiveServer(launch.server), dir = p.input.value.trim();
    if (!dir) { p.host.hidden = true; p.host.replaceChildren(); p.blockers = []; announce(p); return; }
    p.host.hidden = false;
    let where;
    try { where = await ask(server, '/api/launch/where', { path: dir }); } catch { if (p.seq === mine) draw(p, null, [], null, '', null); return; }
    if (p.seq !== mine) return;
    // the recents' own branch and state: a few more reads, each its own repository (a computer that cannot answer leaves that row bare)
    const recents = (where.recent || []).filter(r => r !== where.path).slice(0, 3);
    const states = await Promise.all(recents.map(r => ask(server, '/api/launch/where', { path: r }).catch(() => null)));
    if (p.seq !== mine) return;
    const type = kindType(p.kind);
    let cli = null;
    if (type) { try { cli = await ask(server, '/api/system/cli-check', { type, signin: '1' }); } catch { cli = null; } }
    if (p.seq !== mine) return;
    // the server's own checks for what was chosen: the branch exists and is free, the worktree's folder is free, the folder is trusted
    let checks = null;
    if (where.is_repo) {
        const q = { path: dir };
        if (p.choice === 'new') { q.new_worktree = p.name || ''; if (p.base) q.base = p.base; if (p.folderEdited && p.folder) q.worktree_path = p.folder; }
        else if (p.choice === 'other' && p.other) q.branch = p.other;
        if (type) q.type = type;
        if (p.choice !== 'new' || p.name) { try { checks = await ask(server, '/api/launch/check', q); } catch { checks = null; } }
    }
    if (p.seq !== mine) return;
    draw(p, where, recents.map((path, i) => ({ path, where: states[i] })), cli, type, checks);
}

/** The agent type this launch will run, when it runs one (a terminal runs none). */
function kindType(kind) {
    if (kind === 'terminal') return '';
    const sel = document.getElementById(kind === 'team' ? 'team-agent-type' : 'launch-type');
    return sel?.value || 'claude';
}

const pickFolder = (p, path) => { p.input.value = path; p.input.dispatchEvent(new Event('input', { bubbles: true })); p.choice = 'here'; p.existing = ''; p.folderEdited = false; p.folder = ''; refresh(p); };

/** The agent working in a worktree folder, by the dashboard's own live list (this computer's sessions only: a folder is a computer's own). */
function sessionIn(path) {
    const srv = _effectiveServer(launch.server) || 'local';
    return (state.liveSessions || []).find(x => x && x.working_dir === path && ((x.server || 'local') === srv));
}
const agentIn = path => { const s = sessionIn(path); return s ? (s.display_name || s.name || s.session_name || 'an agent') : ''; };

function drawRecents(p, where, recents, here) {
    if (!recents.length) return null;
    const sec = node('div', 'launch-where-sec'); sec.append(node('h4', 'launch-where-h', `Recent repos on ${here}`));
    const list = node('div', 'launch-where-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', `Recent repos on ${here}`);
    for (const r of recents) {
        const row = node('label', 'launch-where-opt');
        const radio = node('input'); radio.type = 'radio'; radio.name = `launch-where-recent-${p.kind}`; radio.value = r.path; radio.checked = r.path === where.path;
        radio.addEventListener('change', () => pickFolder(p, r.path));
        const text = node('span', 'launch-where-opt-text'); text.append(node('span', 'launch-where-path', tail(r.path)));
        if (r.where?.is_repo) { text.append(' ', node('span', 'launch-where-branch', r.where.branch || 'detached')); for (const t of stateTags(r.where)) text.append(' ', tagNode(t)); }
        row.append(radio, text); list.append(row);
    }
    sec.append(list);
    return sec;
}

/** The branch the agent works on, as the mock's radio list: this folder as it is, a new worktree, a worktree that exists, another branch. A terminal says it the same way. */
function drawBranch(p, where, here) {
    const sec = node('div', 'launch-where-sec launch-where-branches');
    sec.append(node('h4', 'launch-where-h', 'Branch'), node('span', 'launch-where-hint', p.kind === 'terminal' ? 'where the terminal opens' : 'where the agent works'));
    const wts = (where.worktrees || []).filter(w => !w.here && w.path);
    const free = wts.filter(w => !agentIn(w.path)), busy = wts.length - free.length;
    const branch = where.branch || 'detached HEAD';
    const options = [
        { id: 'here', title: 'Use this folder as it is', chips: [[branch, ''], ...stateTags(where)], sub: where.changed ? `${p.kind === 'terminal' ? 'it opens' : 'the agent starts'} with your ${where.changed} uncommitted change${where.changed === 1 ? '' : 's'}` : `${p.kind === 'terminal' ? 'it opens' : 'the agent edits'} ${branch} directly` },
        { id: 'new', title: `New worktree from ${where.branch || 'the current commit'}`, sub: where.worktree_launch === false ? 'Off: turn on “Enable launch into git worktree (experimental)” in Settings' : 'a separate copy on its own branch; your folder is untouched', off: where.worktree_launch === false },
    ];
    if (wts.length) options.push({ id: 'exists', title: 'A worktree that exists', chips: [[`${free.length} free`, ''], ...(busy ? [[`${busy} in use`, '']] : [])], sub: 'pick one below' });
    options.push({ id: 'other', title: 'Another branch', sub: where.changed ? `switches the folder; asks first because it has ${where.changed} change${where.changed === 1 ? '' : 's'}` : 'switches the folder; asks first if it has changes', off: !(where.branches || []).filter(b => b !== where.branch).length });
    if (options.find(o => o.id === p.choice)?.off) p.choice = 'here';
    const list = node('div', 'launch-where-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', 'Branch');
    for (const o of options) {
        const row = node('label', `launch-where-opt${o.off ? ' launch-where-opt-off' : ''}`);
        const radio = node('input'); radio.type = 'radio'; radio.name = `launch-where-branch-${p.kind}`; radio.value = o.id; radio.checked = p.choice === o.id; radio.disabled = !!o.off;
        radio.addEventListener('change', () => {
            p.choice = o.id; p.confirmCheckout = false;
            if (o.id === 'new' && !p.name) { p.name = randomName(); p.base = where.branch || ''; }
            refresh(p);
        });
        const text = node('span', 'launch-where-opt-text');
        const head = node('span', 'launch-where-opt-title', o.title); text.append(head);
        for (const c of o.chips || []) text.append(' ', c.length === 2 && typeof c[1] === 'string' && ['ok', 'warn', 'info'].includes(c[1]) ? tagNode(c) : node('span', 'chip chip-tag', c[0]));
        if (o.sub) text.append(node('span', 'launch-where-opt-sub', o.sub));
        row.append(radio, text); list.append(row);
    }
    sec.append(list);

    if (p.choice === 'new') {
        const f = node('div', 'launch-where-fields');
        const nameId = `launch-where-name-${p.kind}`, dirId = `launch-where-folder-${p.kind}`;
        const nameIn = node('input', 'field launch-where-input'); nameIn.id = nameId; nameIn.type = 'text'; nameIn.value = p.name; nameIn.spellcheck = false; nameIn.setAttribute('aria-label', 'New branch name');
        const dirIn = node('input', 'field launch-where-input'); dirIn.id = dirId; dirIn.type = 'text'; dirIn.spellcheck = false; dirIn.setAttribute('aria-label', 'Worktree folder');
        const defaultDir = () => `${where.worktree_dir || ''}/${p.name}`;
        dirIn.value = p.folderEdited ? p.folder : defaultDir();
        let t = 0; const again = () => { clearTimeout(t); t = setTimeout(() => refresh(p), 350); };
        nameIn.addEventListener('input', () => { p.name = nameIn.value.trim(); if (!p.folderEdited) dirIn.value = defaultDir(); again(); publish(p); });
        dirIn.addEventListener('input', () => { p.folder = dirIn.value.trim(); p.folderEdited = !!p.folder && p.folder !== defaultDir(); again(); publish(p); });
        const lab = (t, hint) => { const r = node('div', 'launch-where-labelrow'); r.append(node('label', 'launch-where-label', t)); if (hint) r.append(node('span', 'launch-where-hint', hint)); return r; };
        const a = node('div', 'launch-where-field'); a.append(lab('Branch name', ''), nameIn);
        const b = node('div', 'launch-where-field launch-where-field-wide'); b.append(lab('Folder', 'edit if you like'), dirIn);
        a.firstChild.setAttribute('for', nameId); b.firstChild.setAttribute('for', dirId);
        f.append(a, b); sec.append(f);
    } else if (p.choice === 'exists') {
        const pick = node('div', 'launch-where-list'); pick.setAttribute('role', 'radiogroup'); pick.setAttribute('aria-label', 'Worktrees');
        for (const w of wts) {
            const who = agentIn(w.path);
            const row = node('label', 'launch-where-opt');
            const radio = node('input'); radio.type = 'radio'; radio.name = `launch-where-wt-${p.kind}`; radio.value = w.path; radio.checked = p.existing === w.path;
            radio.addEventListener('change', () => { p.existing = w.path; p.input.value = w.path; p.input.dispatchEvent(new Event('input', { bubbles: true })); p.choice = 'exists'; });
            const text = node('span', 'launch-where-opt-text'); text.append(node('span', 'launch-where-path', w.branch || 'detached'), ' ', node('span', `chip chip-tag launch-where-tag-${who ? 'warn' : 'ok'}`, who ? 'in use' : 'free'));
            text.append(node('span', 'launch-where-opt-sub', who ? `agent ${who} is working here` : tail(w.path)));
            row.append(radio, text); pick.append(row);
        }
        sec.append(pick);
    } else if (p.choice === 'other') {
        const sel = node('select', 'field launch-where-select'); sel.setAttribute('aria-label', 'Another branch of this repository');
        sel.append(Object.assign(node('option', '', 'Pick a branch'), { value: '' }));
        for (const b of (where.branches || []).filter(x => x !== where.branch)) sel.append(Object.assign(node('option', '', b), { value: b, selected: b === p.other }));
        sel.addEventListener('change', () => { p.other = sel.value; p.confirmCheckout = false; refresh(p); });
        sec.append(sel);
    }
    return sec;
}

/** The items of the setup check, from what was read: { tone: 'ok' | 'warn' | 'fail' | 'info' | 'unknown', title, detail, fix: { label, run, primary } }. */
function checkItems(p, where, cli, type, checks) {
    const here = computerName(), items = [];
    if (!where.exists) return [{ tone: 'warn', title: 'This folder does not exist yet', detail: 'Coral can create it when you launch.' }];
    if (!where.is_repo) {
        items.push({ tone: 'info', title: 'Not a git repository', detail: 'It works in the folder as it is: there is no branch or worktree to pick.' });
    } else {
        items.push({ tone: 'ok', title: 'Repo found', detail: `${tail(where.root)} on ${here}` });
        const chosenElsewhere = p.choice === 'new' || p.choice === 'exists';
        if (where.changed && !chosenElsewhere) {
            items.push({ tone: 'warn', title: `${where.changed} uncommitted change${where.changed === 1 ? '' : 's'}`, detail: `The agent will see and may edit them. A worktree would leave them alone.`, fix: p.kind !== 'team' && where.worktree_launch !== false ? { label: 'Use a worktree', run: () => { p.choice = 'new'; p.name ||= randomName(); p.base = where.branch || ''; refresh(p); } } : null });
        }
        if (where.behind && !chosenElsewhere) items.push({ tone: 'warn', title: `${where.behind} commit${where.behind === 1 ? '' : 's'} behind ${where.upstream || 'origin'}`, detail: 'You may start from old code.' });
        if (where.detached && p.choice === 'here') items.push({ tone: 'warn', title: 'Not on a branch', detail: 'The folder is on a commit, not a branch.' });
        for (const c of checks?.checks || []) {
            if (c.id === 'branch' && p.choice === 'other') items.push(c.ok ? { tone: 'ok', title: `Branch ${p.other} exists` } : { tone: 'fail', title: c.reason, detail: c.fix });
            else if (c.id === 'branch_free' && !c.ok) items.push({ tone: 'fail', title: c.reason, detail: c.fix });
            else if (c.id === 'base' && !c.ok) items.push({ tone: 'fail', title: c.reason, detail: c.fix });
            else if (c.id === 'worktree_free') items.push(c.ok ? { tone: 'ok', title: 'Worktree folder is free', detail: `${p.name} does not exist yet` } : { tone: 'fail', title: c.reason, detail: c.fix });
        }
        if (p.choice === 'new') items.push({ tone: 'info', title: 'A new branch', detail: `${p.name || 'The worktree'} is made from ${p.base || where.branch || 'the current commit'}.` });
        if (p.choice === 'exists' && p.existing) { const who = agentIn(p.existing); if (who) items.push({ tone: 'fail', title: 'This worktree is in use', detail: `Two agents on the same files overwrite each other. ${who} is working here.`, why: 'pick a free worktree, or open the agent already there', fixes: [{ label: `Open ${who}`, run: () => { const s = sessionIn(p.existing); window.hideLaunchModal?.(); importOnce('./sessions.js').then(m => m.selectLiveSession(s.name || s.session_name, s.agent_type, s.session_id, _effectiveServer(launch.server))).catch(() => {}); } }, { label: 'Pick a free one', run: () => { p.existing = ''; p.input.value = where.path; refresh(p); } }] }); }
        if (p.choice === 'other' && p.other && where.changed && !p.confirmCheckout) items.push({ tone: 'fail', title: `${where.changed} uncommitted change${where.changed === 1 ? '' : 's'} in this folder`, detail: `Switching to ${p.other} may carry them along or stop on a conflict.`, fix: { label: 'Switch anyway', run: () => { p.confirmCheckout = true; refresh(p); } }, confirm: true });
        if (p.choice === 'other' && !p.other) items.push({ tone: 'fail', title: 'Pick the branch to switch to', detail: '' });
    }
    if (type && cli) {
        const name = type.charAt(0).toUpperCase() + type.slice(1);
        if (cli.supported === false) items.push({ tone: 'fail', title: `${name} is not offered on ${here}`, detail: cli.message || '' });
        else if (cli.found === false) items.push({ tone: 'fail', title: `${name} is not installed on ${here}`, detail: 'Install it there, then check again.' });
        else if (cli.signed_in === false) { const server = _effectiveServer(launch.server); items.push({ tone: 'fail', title: `${name} is installed but not signed in on ${here}`, detail: isLocalServer(server) && !isCloud() ? 'Launching now would stop at the CLI’s sign-in.' : `Sign in on ${here} itself, then check again: launching now would stop at the CLI’s sign-in.`, fix: isLocalServer(server) && !isCloud() ? { label: `Sign in on ${here}`, primary: true, signin: type } : null }); }
        else if (cli.signed_in === true) items.push({ tone: 'ok', title: `${name} is installed and signed in`, detail: cli.version ? `version ${cli.version} on ${here}` : `on ${here}` });
        else items.push({ tone: 'unknown', title: `${name} sign-in: not checked`, detail: cli.signin_timeout ? 'Its sign-in did not answer: not checked, and it does not block.' : `${name} cannot be asked. If it needs you to sign in, it says so in its terminal and the agent waits there.` });
    }
    const trust = (checks?.checks || []).find(c => c.id === 'trusted');
    if (trust) items.push(trust.reason ? { tone: /^not checked/.test(trust.reason) ? 'unknown' : 'warn', title: /^not checked/.test(trust.reason) ? 'Folder trust: not checked' : 'Folder is not trusted yet', detail: trust.reason.replace(/^not checked: /, '') } : { tone: 'ok', title: 'Folder is trusted', detail: 'the agent will not stop to ask' });
    return items;
}

const MARK = { ok: '✓', fail: '✕', warn: '!', info: 'i', unknown: '?' };

function draw(p, where, recents, cli, type, checks) {
    const host = p.host; host.replaceChildren();
    const here = computerName();
    p.blockers = [];
    if (!where) { host.append(node('p', 'launch-where-note', `${here} did not answer, so its folders could not be read. Nothing was changed.`)); announce(p); return; }
    const rec = drawRecents(p, where, recents, here); if (rec) host.append(rec);
    if (where.is_repo && p.kind !== 'team') host.append(drawBranch(p, where, here));

    const items = checkItems(p, where, cli, type, checks);
    p.blockers = items.filter(i => i.tone === 'fail');
    if (items.length) {
        const sec = node('div', 'launch-where-sec launch-where-check'); sec.setAttribute('role', 'group'); sec.setAttribute('aria-label', 'Setup check');
        const fails = p.blockers.length, warns = items.filter(c => c.tone === 'warn').length, unk = items.filter(c => c.tone === 'unknown').length;
        const head = node('div', 'launch-where-check-head'); head.append(node('h4', 'launch-where-h', 'Setup check'));
        const sum = node('span', 'launch-where-summary');
        sum.append(...(fails ? [node('span', 'chip chip-tag launch-where-tag-fail', `${fails} to fix`)] : []), ...(warns ? [' ', node('span', 'chip chip-tag launch-where-tag-warn', `${warns} to know`)] : []), ...(unk ? [' ', node('span', 'chip chip-tag', `${unk} not checked`)] : []), ...(!fails && !warns && !unk ? [node('span', 'chip chip-tag launch-where-tag-ok', 'all good')] : []), ...(!fails && (warns || unk) ? [' ', node('span', 'chip chip-tag launch-where-tag-ok', 'can launch')] : []));
        head.append(sum); sec.append(head);
        const ul = node('ul', 'launch-where-checks');
        for (const c of items) {
            const li = node('li', `launch-where-item launch-where-item-${c.tone}`);
            const mark = node('span', 'launch-where-mark', MARK[c.tone] || 'i'); mark.setAttribute('aria-hidden', 'true');
            const body = node('span', 'launch-where-item-body');
            body.append(node('span', 'sr-only', { ok: 'Passed: ', fail: 'Problem: ', warn: 'Warning: ', unknown: 'Not checked: ', info: '' }[c.tone] || ''), node('span', 'launch-where-item-title', c.title));
            if (c.detail) body.append(node('span', 'launch-where-item-detail', c.detail));
            li.append(mark, body);
            const row = node('span', 'launch-where-fixes'); for (const f of c.fixes || (c.fix ? [c.fix] : [])) row.append(fixButton(p, f)); if (row.childNodes.length) li.append(row);
            ul.append(li);
        }
        sec.append(ul);
        const why = node('p', 'launch-where-why'); why.id = `launch-where-why-${p.kind}`; why.setAttribute('role', 'status'); why.textContent = blockerSentence(p, here);
        why.hidden = !fails;
        sec.append(why);
        if (fails) { sec.setAttribute('data-blocks-launch', ''); sec.dataset.whereBlocks = ''; }
        host.append(sec);
    }
    announce(p);
}

/** "Fix 1 thing to continue: sign in to Claude on Laptop." The first problem's own words, made into the one thing to do. */
function blockerSentence(p, here) {
    const n = p.blockers.length;
    if (!n) return '';
    const first = p.blockers[0], f0 = first.fix || first.fixes?.[0];
    const todo = first.why || (f0 && f0.signin ? `sign in to ${f0.signin.charAt(0).toUpperCase() + f0.signin.slice(1)} on ${here}` : f0?.label ? f0.label.charAt(0).toLowerCase() + f0.label.slice(1) : String(first.title).replace(/\.$/, ''));
    return `Fix ${n === 1 ? '1 thing' : `${n} things`} to continue: ${todo}.`;
}

function fixButton(p, fix) {
    const b = node('button', `btn btn-small launch-where-fix${fix.primary ? ' btn-primary' : ''}`, fix.label); b.type = 'button';
    b.addEventListener('click', async () => {
        if (!fix.signin) { fix.run(); return; }
        b.disabled = true; b.textContent = 'Opening a terminal…';
        try {
            const r = await serverFetch(_effectiveServer(launch.server), `/api/system/cli-signin?type=${encodeURIComponent(fix.signin)}`, { method: 'POST', cache: 'no-store' });
            const j = r.ok ? await r.json() : {};
            b.textContent = j.started ? 'Finish in the terminal, then check again' : (j.message || 'Could not open a terminal');
            if (j.started && j.session_name) (await importOnce('./sessions.js')).selectLiveSession(j.session_name, 'terminal', j.session_id, _effectiveServer(launch.server)).catch(() => {});
        } catch { b.textContent = 'Could not open a terminal'; }
        setTimeout(() => { if (b.isConnected) { b.disabled = false; b.textContent = fix.label; } }, 4000);
    });
    return b;
}

/** Keep launch.where[kind] what the launch carries (launch_dialog.js adds it to its request). */
function publish(p) { (launch.where ||= {})[p.kind] = wherePayload(p.kind); }

/** Tell the launch dialog whether anything here stops the launch (its Launch and Next go off, with the sentence as their description). */
function announce(p) {
    publish(p);
    p.host.dispatchEvent(new CustomEvent('cli-blocks-launch', { bubbles: true })); // the dialog's Launch reads the blockers (launch_dialog.js _syncLaunchBlock); Next waits here
    const next = p.kind === 'agent' ? document.getElementById('launch-agent-next') : null, why = p.host.querySelector('[data-where-blocks] .launch-where-why');
    if (next) { next.disabled = !!why; if (why) next.setAttribute('aria-describedby', why.id); else next.removeAttribute('aria-describedby'); }
    if (p.kind === 'agent') importOnce('./launch_recap.js').then(m => m.syncRecap()).catch(() => {}); // the recap above the footer says the worktree or branch
    p.host.dispatchEvent(new CustomEvent('launch-where-blocks', { bubbles: true, detail: { kind: p.kind, blocked: (p.blockers || []).length > 0 } }));
}

/** What the launch carries from this step: a new worktree {name, base, path} or the branch to switch to (with the person's yes when the folder has changes). Nothing for "this folder as it is" or a worktree that exists (its folder is the folder). */
export function wherePayload(kind) {
    const p = panels[kind];
    if (!p?.host.isConnected || p.host.hidden) return {};
    if (p.choice === 'new' && p.name) return { new_worktree: { name: p.name, ...(p.base ? { base: p.base } : {}), ...(p.folderEdited && p.folder ? { path: p.folder } : {}) } };
    if (p.choice === 'other' && p.other) return { checkout_branch: p.other, ...(p.confirmCheckout ? { confirm_checkout: true } : {}) };
    return {};
}

/** The words for the recap above the footer: "new worktree fix-login from main", "branch other", or '' (the folder as it is). */
export function whereRecap(kind) {
    const p = panels[kind];
    if (!p?.host.isConnected || p.host.hidden) return '';
    if (p.choice === 'new' && p.name) return `new worktree ${p.name}${p.base ? ` from ${p.base}` : ''}`;
    if (p.choice === 'other' && p.other) return `branch ${p.other}`;
    return '';
}
