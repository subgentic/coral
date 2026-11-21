/* The shared "Where" step of a launch (#20388, mock #20111), for New agent, New team and New terminal: under the folder field, the recent repos on THAT computer with their branch and state, the branch of the folder
 * and whether it is clean, ahead or behind, the worktrees it has (pick one to launch in it), and the setup check: each item with a plain reason and the way to fix it. Everything is asked of the computer the
 * launch is for (through the per-computer routes: GET /api/launch/where and /api/launch/check, and cli-check for the agent's CLI), never of this one. Words from a computer are text, never markup. */
import { importOnce } from './import_once.js';
import { serverFetch } from './server_base.js';
import { serverLabel } from './launch_server.js';
import { state } from './state.js';
import { loadStyles } from './lazy_styles.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer } = await importOnce('./launch_models.js');

const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const MOUNTS = { agent: { input: 'launch-dir', after: 'agent-form-host' }, terminal: { input: 'launch-terminal-dir', after: null }, team: { input: 'launch-team-dir', after: 'team-form-host' } };
const shortPath = p => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
const tail = p => shortPath(p);

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
    const anchor = m.after ? document.getElementById(m.after) : input.closest('.form-row');
    if (!anchor) return null;
    anchor.after(host);
    const p = panels[kind] = { host, kind, input, refresh: () => refresh(p) };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => refresh(p), 350); };
    input.addEventListener('input', later); input.addEventListener('change', later);
    refresh(p);
    return p;
}

const computerName = () => serverLabel(_effectiveServer(launch.server), state.servers);

async function refresh(p) {
    const mine = ++seq; p.seq = mine;
    const server = _effectiveServer(launch.server), dir = p.input.value.trim();
    if (!dir) { p.host.hidden = true; p.host.replaceChildren(); return; }
    p.host.hidden = false;
    let where;
    try { where = await ask(server, '/api/launch/where', { path: dir }); } catch { if (p.seq === mine) draw(p, null, [], null); return; }
    if (p.seq !== mine) return;
    // the recents' own branch and state: a few more reads, each its own repository (a computer that cannot answer leaves that row bare)
    const recents = (where.recent || []).filter(r => r !== where.path).slice(0, 3);
    const states = await Promise.all(recents.map(r => ask(server, '/api/launch/where', { path: r }).catch(() => null)));
    if (p.seq !== mine) return;
    const type = kindType(p.kind);
    let cli = null;
    if (type) { try { cli = await ask(server, '/api/system/cli-check', { type, signin: '1' }); } catch { cli = null; } }
    if (p.seq !== mine) return;
    draw(p, where, recents.map((path, i) => ({ path, where: states[i] })), cli, type);
}

/** The agent type this launch will run, when it runs one (a terminal runs none). */
function kindType(kind) {
    if (kind === 'terminal') return '';
    const sel = document.getElementById(kind === 'team' ? 'team-agent-type' : 'launch-type');
    return sel?.value || 'claude';
}

function draw(p, where, recents, cli, type) {
    const host = p.host; host.replaceChildren();
    const here = computerName();
    if (!where) { host.append(node('p', 'launch-where-note', `${here} did not answer, so its folders could not be read. Nothing was changed.`)); return; }

    // recent repos on that computer
    if (recents.length) {
        const sec = node('div', 'launch-where-sec'); sec.append(node('h4', 'launch-where-h', `Recent repos on ${here}`));
        const list = node('div', 'launch-where-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', `Recent repos on ${here}`);
        for (const r of recents) {
            const row = node('label', 'launch-where-opt');
            const radio = node('input'); radio.type = 'radio'; radio.name = `launch-where-recent-${p.kind}`; radio.value = r.path; radio.checked = r.path === where.path;
            radio.addEventListener('change', () => { p.input.value = r.path; p.input.dispatchEvent(new Event('input', { bubbles: true })); refresh(p); });
            const text = node('span', 'launch-where-opt-text'); text.append(node('span', 'launch-where-path', tail(r.path)));
            if (r.where?.is_repo) { text.append(' ', node('span', 'launch-where-branch', r.where.branch || 'detached')); for (const t of stateTags(r.where)) text.append(' ', tagNode(t)); }
            row.append(radio, text); list.append(row);
        }
        sec.append(list); host.append(sec);
    }

    // the folder's branch and its worktrees
    if (where.is_repo) {
        const sec = node('div', 'launch-where-sec'); sec.append(node('h4', 'launch-where-h', 'Branch where it works'));
        const line = node('p', 'launch-where-branchline'); line.append(node('span', 'launch-where-branch', where.branch || 'detached HEAD'));
        for (const t of stateTags(where)) line.append(' ', tagNode(t));
        sec.append(line);
        const others = (where.worktrees || []).filter(w => !w.here && w.path);
        if (others.length) {
            const pick = node('div', 'launch-where-wts');
            pick.append(node('label', 'launch-where-sub', 'Or launch in a worktree that exists'));
            const sel = node('select', 'field launch-where-select'); sel.setAttribute('aria-label', 'A worktree of this repository');
            sel.append(Object.assign(node('option', '', 'Pick one (this folder as it is)'), { value: '' }));
            for (const w of others) sel.append(Object.assign(node('option', '', `${w.branch || 'detached'} · ${tail(w.path)}`), { value: w.path }));
            sel.addEventListener('change', () => { if (!sel.value) return; p.input.value = sel.value; p.input.dispatchEvent(new Event('input', { bubbles: true })); refresh(p); });
            pick.append(sel); sec.append(pick);
        }
        host.append(sec);
    }

    // the setup check
    const checks = [];
    if (!where.exists) checks.push({ tone: 'warn', title: 'This folder does not exist yet', detail: 'Coral can create it when you launch.' });
    else if (where.is_repo) {
        checks.push({ tone: 'ok', title: 'Repo found', detail: tail(where.root) });
        if (where.changed) checks.push({ tone: 'warn', title: `${where.changed} uncommitted change${where.changed === 1 ? '' : 's'}`, detail: 'The agent will see and may edit them.' });
        if (where.behind) checks.push({ tone: 'warn', title: `${where.behind} commit${where.behind === 1 ? '' : 's'} behind ${where.upstream || 'origin'}`, detail: 'You may start from old code.' });
        if (where.detached) checks.push({ tone: 'warn', title: 'Not on a branch', detail: 'The folder is on a commit, not a branch.' });
    } else checks.push({ tone: 'info', title: 'Not a git repository', detail: 'It works in the folder as it is: there is no branch or worktree to pick.' });
    if (type && cli) {
        const name = type.charAt(0).toUpperCase() + type.slice(1);
        if (cli.supported === false) checks.push({ tone: 'fail', title: `${name} is not offered on ${here}`, detail: cli.message || '' });
        else if (cli.found === false) checks.push({ tone: 'fail', title: `${name} is not installed on ${here}`, detail: 'Install it there, then check again.' });
        else if (cli.signed_in === false) checks.push({ tone: 'fail', title: `${name} is installed but not signed in on ${here}`, detail: 'Launching now would stop at the CLI’s sign-in.' });
        else if (cli.signed_in === true) checks.push({ tone: 'ok', title: `${name} is installed and signed in`, detail: cli.version ? `version ${cli.version} on ${here}` : `on ${here}` });
        else checks.push({ tone: cli.found === true ? 'ok' : 'info', title: `${name} is installed`, detail: cli.signin_timeout ? 'Its sign-in did not answer: not checked.' : 'Its sign-in cannot be asked: not checked, and it does not block.' });
    }
    if (checks.length) {
        const sec = node('div', 'launch-where-sec launch-where-check'); sec.setAttribute('role', 'status'); sec.append(node('h4', 'launch-where-h', 'Setup check'));
        const fails = checks.filter(c => c.tone === 'fail').length, warns = checks.filter(c => c.tone === 'warn').length;
        sec.append(node('span', 'launch-where-summary', fails ? `${fails} to fix` : warns ? `${warns} to know` : 'all good'));
        const ul = node('ul', 'launch-where-checks');
        for (const c of checks) { const li = node('li', `launch-where-item launch-where-item-${c.tone}`); li.append(node('span', 'launch-where-mark', c.tone === 'ok' ? '✓' : c.tone === 'fail' ? '✕' : c.tone === 'warn' ? '!' : 'i'), node('span', 'launch-where-item-title', c.title)); if (c.detail) li.append(node('span', 'launch-where-item-detail', c.detail)); ul.append(li); }
        sec.append(ul); host.append(sec);
    }
}

/** Re-read the panel of kind (the type or the folder changed). */
export function refreshLaunchWhere(kind) { const p = panels[kind]; if (p?.host.isConnected) p.refresh(); }
