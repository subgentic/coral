/* The Inbox says so when Claude is signed out (#15093, walk 2 finding 7): an Inbox-only user saw nothing while background jobs waited for a sign-in. A notice at the top of Needs you, only while the server says
 * Claude is not signed in AND an agent launched with Claude is on this computer (the Operator: not merely Claude installed). Open terminal opens that agent's terminal, where the sign-in is finished;
 * Check again asks the CLI itself (the card's own question); Dismiss hides it for a day, and a sign-in clears the dismissal. Lazy: the Needs you list leaves a slot and this fills it. */
import { claudeSignedIn, onSigninChange, setClaudeSignedIn, isLocalClaude } from './signin_line.js';
import { openAgent } from './agent_live.js';
import { state } from './state.js';
import { browserLocal } from './safe_storage.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';

const KEY = 'coral-inbox-signin-dismissed', DAY = 24 * 60 * 60 * 1000;
const dismissed = () => { const at = Number(browserLocal.get(KEY)); return Number.isFinite(at) && at > 0 && Date.now() - at < DAY; };
/** The Claude agent to open: one that has not started (waiting for the sign-in) first, else the first on this computer; null when there is none. */
export const claudeAgent = () => { const rows = (state.liveSessions || []).filter(isLocalClaude); return rows.find(s => s.waiting_kind) || rows[0] || null; };
/** Whether the notice shows now. */
export const shows = () => claudeSignedIn() === false && !!claudeAgent() && !dismissed();

export function mountInboxSigninNotice(slot) {
    if (!slot) return;
    loadStyles('inbox_signin_notice.css').catch(() => {});
    const box = el('div', 'notice notice-warn inbox-signin-notice'); box.setAttribute('role', 'status'); box.hidden = true;
    const icon = el('span', 'material-icons', 'info'); icon.setAttribute('aria-hidden', 'true');
    const body = el('div', 'inbox-signin-body');
    body.append(el('strong', 'inbox-signin-lead', "Claude isn't signed in on this computer."), el('p', 'inbox-signin-text', 'Agents that use Claude, and background jobs, wait until it is. Open the terminal, finish the steps it shows, then press Check again. You can also run claude in any terminal on this computer.'));
    const row = el('div', 'inbox-signin-actions');
    const open = el('button', 'btn btn-primary', 'Open terminal to sign in'); open.type = 'button';
    const again = el('button', 'btn', 'Check again'); again.type = 'button';
    const later = el('button', 'btn', 'Dismiss for a day'); later.type = 'button';
    const said = el('span', 'inbox-signin-said'); said.setAttribute('role', 'status');
    row.append(open, again, later, said); body.append(row); box.append(icon, body); slot.replaceChildren(box);
    const sync = () => { const on = shows(); if (box.hidden === on) box.hidden = !on; };
    open.addEventListener('click', async () => {
        const s = claudeAgent(); if (!s) { said.textContent = 'No Claude agent is running on this computer.'; return; }
        openAgent(s);
        for (let i = 0; i < 50 && state.currentSession?.session_id !== s.session_id; i++) await new Promise(r => setTimeout(r, 100));
        window.showTerminalView?.();
    });
    again.addEventListener('click', async () => {
        again.disabled = true; said.textContent = 'Checking…';
        try {
            const r = await fetch('/api/system/cli-check?type=claude&signin=1&source=cli_recheck', { cache: 'no-store' });
            const d = r.ok ? await r.json() : null, v = d && typeof d.signed_in === 'boolean' ? d.signed_in : undefined;
            if (typeof v === 'boolean') setClaudeSignedIn(v);
            said.textContent = v === true ? 'Claude is signed in.' : v === false ? 'Claude is still not signed in.' : 'Could not tell whether Claude is signed in.';
        } catch { said.textContent = 'Could not tell whether Claude is signed in.'; }
        again.disabled = false;
    });
    later.addEventListener('click', () => {
        browserLocal.set(KEY, String(Date.now())); sync();
        const next = [document.querySelector('#group-table-view .gt-toolbar input, #group-table-view .gt-toolbar button')].find(e => e && e.getClientRects().length); next?.focus();
    });
    const stop = onSigninChange(v => { if (!box.isConnected) { stop(); return; } if (v === true) browserLocal.remove(KEY); sync(); });
    sync();
}
