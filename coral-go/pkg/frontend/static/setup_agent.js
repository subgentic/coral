/* Get an agent ready (#18752): the Inbox's "Get set up" row and the New agent / New team buttons open this when none of Claude, Codex or Antigravity is installed. Its own file: the start does not carry it.
 * "Ready" is what the launch form already asks the server (GET /api/system/cli-check): that agent's CLI is found. The install lines are the ones Coral shows on a missing CLI. */
import { importOnce } from './import_once.js';
import { serverFetch, currentServer } from './server_base.js';
import { state } from './state.js';

const PROVIDERS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['agy', 'Antigravity']];
const FRESH_MS = 20000;
let _last = null, _at = 0;

async function found(server, type) {
    try {
        const r = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(type)}`, { cache: 'no-store' });
        if (!r.ok) return null;
        const d = await r.json();
        return d.supported === false ? false : (typeof d.found === 'boolean' ? d.found : null);
    } catch { return null; }
}

/** { claude, codex, agy }: true found, false not found, null when the server could not say. Kept for 20 s; `force` asks again. */
export async function readyProviders(force = false, server = currentServer()) {
    if (!force && _last && Date.now() - _at < FRESH_MS) return _last;
    const got = await Promise.all(PROVIDERS.map(([type]) => found(server, type)));
    _last = Object.fromEntries(PROVIDERS.map(([type], i) => [type, got[i]])); _at = Date.now();
    return _last;
}
/** True only when the server said every one of the three is missing: a probe that failed or timed out never blocks anyone. */
export const noneReady = async force => Object.values(await readyProviders(force)).every(v => v === false);
/** The cached answer, no wait: true when the last probe found none; false when unknown or one is ready. */
export const noneReadyNow = () => !!_last && Date.now() - _at < FRESH_MS && Object.values(_last).every(v => v === false);

/** The agent type a new agent or team starts on: when the person has none chosen, or the one they chose is not installed, it becomes the one that is ready (Try a team and New agent then open on it). */
export function adoptDefault(pick) {
    const cur = (state.settings || {}).default_agent_type, curKey = cur === 'antigravity' || cur === 'gemini' ? 'agy' : cur;
    if (!pick || curKey === pick || (curKey && _last && _last[curKey] === true)) return;
    state.settings = { ...(state.settings || {}), default_agent_type: pick };
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_agent_type: pick }) }).catch(() => {});
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

/** The dialog. `onReady` runs when the person continues with a provider that is ready (the launch they clicked, or nothing from the Inbox). */
export async function openSetupDialog({ onReady } = {}) {
    const { CLI_INSTALL_INSTRUCTIONS } = await importOnce('./cli_check.js');
    document.getElementById('setup-agent-modal')?.remove();
    const modal = el('div', 'modal'); modal.id = 'setup-agent-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'setup-agent-title'); modal.style.display = 'flex';
    const box = el('div', 'modal-content dlg-confirm'), head = el('div', 'modal-header'), body = el('div', 'modal-body'), actions = el('div', 'modal-actions modal-footer');
    const title = el('h3', null, 'Get an agent ready'); title.id = 'setup-agent-title'; head.append(title);
    body.append(el('p', 'text-secondary-sm', 'Coral runs agents through one of these. Set one up, then check again.'));
    const win = /^Win/i.test((navigator.userAgentData?.platform || navigator.platform) || '');
    const rows = {};
    for (const [type, label] of PROVIDERS) {
        const info = CLI_INSTALL_INSTRUCTIONS[type] || {}, cmd = (win && info.winCmd) || info.cmd || '';
        const row = el('div', 'setup-agent-row'), top = el('div', 'setup-agent-top'), status = el('span', 'setup-agent-status', 'Checking…'), more = el('button', 'btn btn-secondary', 'Show steps');
        more.type = 'button'; top.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0'; row.style.cssText = 'border-top:1px solid var(--border-color, rgba(128,128,128,.3))';
        const name = el('b', null, label); name.style.minWidth = '110px'; status.style.cssText = 'flex:1;font-size:13px;opacity:.8';
        more.type = 'button'; top.append(name, status, more);
        const steps = el('div', 'setup-agent-steps'); steps.hidden = true; steps.style.cssText = 'padding:0 0 10px 4px;font-size:13px;line-height:1.6;overflow-wrap:anywhere';
        const line = el('p'), code = el('code', null, cmd), copy = el('button', 'btn btn-secondary', 'Copy'); copy.type = 'button';
        copy.onclick = () => { navigator.clipboard?.writeText(cmd).then(() => { copy.textContent = 'Copied'; }).catch(() => {}); };
        line.append('1. Run this in a terminal: ', code, ' ', copy);
        const signin = el('p', null, `2. Run ${info.name || type} once and sign in.`), help = el('p');
        if (info.url) { const a = el('a', null, info.url.replace(/^https?:\/\//, '')); a.href = info.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; help.append('More: ', a); }
        steps.append(line, signin, help);
        more.onclick = () => { steps.hidden = !steps.hidden; more.textContent = steps.hidden ? 'Show steps' : 'Hide steps'; };
        row.append(top, steps); body.append(row); rows[type] = { status, label };
    }
    const result = el('p', 'setup-agent-result'); result.style.minHeight = '1.4em'; result.setAttribute('role', 'status'); body.append(result);
    const check = el('button', 'btn btn-secondary', 'Check again'), go = el('button', 'btn btn-primary', 'Continue'), close = el('button', 'btn btn-secondary', 'Not now');
    for (const b of [check, go, close]) b.type = 'button';
    go.hidden = true; actions.append(close, check, go);
    box.append(head, body, actions); modal.append(box); document.body.append(modal);
    let pick = '';
    const run = async force => {
        check.disabled = true; result.textContent = '';
        const now = await readyProviders(force);
        for (const [type] of PROVIDERS) rows[type].status.textContent = now[type] === true ? 'Ready' : now[type] === false ? 'Not installed' : 'Could not check';
        pick = PROVIDERS.map(([t]) => t).find(t => now[t] === true) || '';
        go.hidden = !pick; result.textContent = pick ? `${rows[pick].label} is ready.` : '';
        check.disabled = false; (pick ? go : check).focus();
    };
    const shut = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') shut(); };
    document.addEventListener('keydown', onKey);
    close.onclick = shut; check.onclick = () => run(true); go.onclick = () => { shut(); adoptDefault(pick); if (onReady) onReady(pick); };
    await run(false);
}
