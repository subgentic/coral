/* Get an agent ready (#18752): the Inbox's "Get set up" row and the New agent / New team buttons open this when none of Claude, Codex or Antigravity is installed. Its own file: the start does not carry it.
 * "Ready" is what the launch form already asks the server (GET /api/system/cli-check): that agent's CLI is found. The install lines are the ones Coral shows on a missing CLI. */
import { importOnce } from './import_once.js';
import { serverFetch, currentServer } from './server_base.js';
import { state } from './state.js';

const PROVIDERS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['agy', 'Antigravity']];
const FRESH_MS = 20000;
let _last = null, _at = 0;

// recheck: the person pressed Check again. The server then re-reads the Path Windows keeps for them (#457), so a CLI installed after Coral started is found without a restart;
// without it this dialog's Check again never could find one (#582: Codex from its standalone installer, on a fresh install).
async function cliFound(server, type, recheck = false) {
    try {
        const r = await serverFetch(server, `/api/system/cli-check?type=${encodeURIComponent(type)}${recheck ? '&source=cli_recheck' : ''}`, { cache: 'no-store' });
        if (!r.ok) return null;
        const d = await r.json();
        return d.supported === false ? false : (typeof d.found === 'boolean' ? d.found : null);
    } catch { return null; }
}

/** { claude, codex, agy }: true found, false not found, null when the server could not say. Kept for 20 s; `force` (the dialog's Check again) asks again, as a re-check. */
export async function readyProviders(force = false, server = currentServer()) {
    if (!force && _last && Date.now() - _at < FRESH_MS) return _last;
    const got = await Promise.all(PROVIDERS.map(([type]) => cliFound(server, type, force)));
    _last = Object.fromEntries(PROVIDERS.map(([type], i) => [type, got[i]])); _at = Date.now();
    return _last;
}
/** True only when the server said every one of the three is missing: a probe that failed or timed out never blocks anyone. */
export const noneReady = async force => Object.values(await readyProviders(force)).every(v => v === false);

/** The agent type a new agent or team starts on: when the person has none chosen, or the one they chose is not installed, it becomes the one that is ready (Try a team and New agent then open on it). */
export function adoptDefault(pick) {
    const cur = (state.settings || {}).default_agent_type, curKey = cur === 'antigravity' || cur === 'gemini' ? 'agy' : cur;
    if (!pick || curKey === pick || (curKey && _last && _last[curKey] === true)) return;
    state.settings = { ...(state.settings || {}), default_agent_type: pick };
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_agent_type: pick }) }).catch(() => {});
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

/** "Installed somewhere else?" (#583): the path of the CLI, saved as cli_path_<type> through the server's own check (the one Settings > Providers uses, which follows Codex's
 * installer junctions, #582), then checked again. A refusal is the server's sentence and what to do. `recheck` is the dialog's Check again; `settings` opens Settings > Providers. */
function pathField(type, label, recheck, settings) {
    const box = el('div', 'setup-agent-path'), lead = el('p', null, `3. Installed somewhere else? Enter the full path to ${label}:`);
    const row = el('div'), input = el('input', 'settings-mono-input'), save = el('button', 'btn', 'Save path'), note = el('p', 'setup-agent-path-note');
    row.style.cssText = 'display:flex;gap:8px;align-items:center'; input.type = 'text'; input.style.flex = '1'; input.spellcheck = false; input.setAttribute('aria-label', `${label} CLI path`);
    input.placeholder = /^Win/i.test((navigator.userAgentData?.platform || navigator.platform) || '') ? `C:\\...\\${type}.exe` : `/usr/local/bin/${type}`;
    save.type = 'button'; note.setAttribute('role', 'status'); note.style.minHeight = '1.2em';
    const open = el('a', null, 'Settings > Providers'); open.href = '#'; open.onclick = e => { e.preventDefault(); settings(); };
    const more = el('p', 'text-secondary-sm'); more.append('Or set it in ', open, '.');
    save.onclick = async () => {
        const path = input.value.trim();
        if (!path) { note.textContent = `Enter the full path to the ${label} program first.`; input.focus(); return; }
        save.disabled = true; note.textContent = 'Saving…';
        try {
            const key = `cli_path_${type}`;
            const r = await serverFetch(currentServer(), '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: path }) });
            if (!r.ok) {
                let why = ''; try { const d = await r.json(); why = String(d.error || d.message || ''); } catch { /* said below */ }
                note.textContent = `Not saved. ${why || `The server answered ${r.status}.`} Enter the full path to the ${label} program file, or set it in Settings > Providers.`;
                return;
            }
            state.settings = { ...(state.settings || {}), [key]: path };
            note.textContent = 'Saved. Checking…';
            await recheck();
            note.textContent = 'Saved.';
        } catch { note.textContent = 'Not saved: the server could not be reached. Try again.'; } finally { save.disabled = false; }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    row.append(input, save); box.append(lead, row, note, more);
    return box;
}

/** The dialog. `onReady` runs when the person continues with a provider that is ready (the launch they clicked, or nothing from the Inbox). */
export async function openSetupDialog({ onReady, onSkip } = {}) {
    const { CLI_INSTALL_INSTRUCTIONS } = await importOnce('./cli_check.js');
    document.getElementById('setup-agent-modal')?.remove();
    const modal = el('div', 'modal'); modal.id = 'setup-agent-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'setup-agent-title'); modal.style.display = 'flex'; // display-ok: a dialog built here, shown at once
    const box = el('div', 'modal-content dlg-confirm'), head = el('div', 'modal-header'), body = el('div', 'modal-body'), actions = el('div', 'modal-actions modal-footer');
    const title = el('h3', null, 'Get an agent ready'); title.id = 'setup-agent-title'; head.append(title);
    body.append(el('p', 'text-secondary-sm', 'Coral runs agents through one of these. Set one up, then check again.'));
    const win = /^Win/i.test((navigator.userAgentData?.platform || navigator.platform) || '');
    const rows = {};
    for (const [type, label] of PROVIDERS) {
        const info = CLI_INSTALL_INSTRUCTIONS[type] || {}, cmd = (win && info.winCmd) || info.cmd || '';
        const row = el('div', 'setup-agent-row'), top = el('div', 'setup-agent-top'), status = el('span', 'setup-agent-status', 'Checking…'), more = el('button', 'btn', 'Show steps');
        more.type = 'button'; top.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0'; row.style.cssText = 'border-top:1px solid var(--border)';
        const name = el('b', null, label); name.style.minWidth = '7rem'; status.style.cssText = 'flex:1;font-size:var(--fs-md);opacity:.8';
        more.type = 'button'; top.append(name, status, more);
        const steps = el('div', 'setup-agent-steps'); steps.hidden = true; steps.style.cssText = 'padding:0 0 10px 4px;font-size:var(--fs-md);line-height:var(--lh-body);overflow-wrap:anywhere';
        const line = el('p'), code = el('code', null, cmd), copy = el('button', 'btn', 'Copy'); copy.type = 'button';
        copy.onclick = () => { navigator.clipboard?.writeText(cmd).then(() => { copy.textContent = 'Copied'; }).catch(() => {}); };
        line.append('1. Run this in a terminal: ', code, ' ', copy);
        const signin = el('p', null, `2. Run ${info.name || type} once and sign in.`), help = el('p');
        if (info.url) { const a = el('a', null, info.url.replace(/^https?:\/\//, '')); a.href = info.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; help.append('More: ', a); }
        steps.append(line);
        if (type === 'codex') steps.append(el('p', null, 'Or use the standalone installer from github.com/openai/codex.')); // what the Operator used (#583): Coral finds that install too (#582)
        steps.append(signin, help, pathField(type, label, () => run(true), () => { shut(); window.showSettingsModal?.('providers'); }));
        more.onclick = () => { steps.hidden = !steps.hidden; more.textContent = steps.hidden ? 'Show steps' : 'Hide steps'; };
        row.append(top, steps); body.append(row); rows[type] = { status, label };
    }
    const result = el('p', 'setup-agent-result'); result.style.minHeight = '1.4em'; result.setAttribute('role', 'status'); body.append(result);
    const check = el('button', 'btn', 'Check again'), go = el('button', 'btn btn-primary', 'Continue'), close = el('button', 'btn', 'Not now');
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
    const skip = () => { shut(); if (onSkip) onSkip(); }; // "Not now" and Escape: what was clicked goes on without an agent set up (someone with only Pi, Hermes or their own CLI path is never stopped)
    const onKey = e => { if (e.key === 'Escape') skip(); };
    document.addEventListener('keydown', onKey);
    close.onclick = skip; check.onclick = () => run(true); go.onclick = () => { shut(); adoptDefault(pick); if (onReady) onReady(pick); };
    await run(false);
}
