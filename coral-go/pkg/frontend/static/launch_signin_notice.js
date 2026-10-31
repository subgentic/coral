/* New Agent's Agent step says so, above the provider cards, when the chosen provider is signed out on this computer (#11336, QA's desktop pass: it was one small grey line behind the dialog that never said how to sign in;
 * then Pi, which lists no models when its default provider is not signed in and fails at launch with "No API key found"). Claude's answer is the page's own status (signin_line.js); Pi's is asked of the CLI
 * (GET /api/system/cli-check?type=pi&signin=1) when Pi is chosen. A notice under the provider, not a block: Launch stays on, because the status can be minutes old and the agent's own chat says what to do
 * the moment it needs it (needs_input_card.js). "How to sign in" opens the steps; a person who signs in first does not need them. */
import { claudeSignedIn, askSigninSoon, onSigninChange } from './signin_line.js';
import { serverFetch, LOCAL_SERVER, normServer } from './server_base.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const WORDS = {
    claude: { lead: "Claude isn't signed in on this computer.", steps: 'Open a terminal, run claude and follow the steps. Or launch now: the agent’s chat then shows Open terminal and Check again.' },
    pi: { lead: "Pi isn't signed in to its default provider on this computer.", steps: 'Open a terminal, run pi, type /login, choose how to sign in, then pick a provider. Or launch now: Pi shows No API key found for the provider and waits for you to sign in.' },
};
const PI_ASK_GAP_MS = 10_000;

export function mountLaunchSigninNotice({ slot, before, form, server }) {
    const select = form && form.querySelector('.acf-agent-type');
    if (!slot || !select) return;
    const host = (before || slot).parentNode; // `before`: the Provider heading, so the notice is the first thing in the section; the slot is at the end of the Agent pane, below the cards, out of sight
    host.querySelector('.launch-signin-notice')?.remove(); // a new dialog draws its own
    const box = el('div', 'notice notice-warn notice-compact launch-signin-notice'); box.hidden = true; box.setAttribute('role', 'status');
    const icon = el('span', 'material-icons', 'info'); icon.setAttribute('aria-hidden', 'true');
    const body = el('div', 'launch-signin-body');
    const lead = el('p', 'launch-signin-lead');
    const how = el('button', 'btn launch-signin-how', 'How to sign in'); how.type = 'button'; how.setAttribute('aria-expanded', 'false');
    const steps = el('p', 'launch-signin-steps'); steps.hidden = true; steps.id = `${slot.id || 'launch'}-signin-steps`;
    how.setAttribute('aria-controls', steps.id);
    how.addEventListener('click', () => { steps.hidden = !steps.hidden; how.setAttribute('aria-expanded', String(!steps.hidden)); });
    body.append(lead, how, steps); box.append(icon, body);
    if (before) before.before(box); else slot.after(box);
    const local = normServer(server) === LOCAL_SERVER;
    let piKnown, piAskedAt = 0; // Pi's last answer: true, false, or undefined (not asked, or the CLI could not say)
    const kind = () => { const t = select.value || 'claude'; return t === 'claude' || t === 'pi' ? t : ''; };
    const sync = () => {
        const k = kind(), out = local && ((k === 'claude' && claudeSignedIn() === false) || (k === 'pi' && piKnown === false));
        if (out) {
            if (lead.dataset.kind !== k) { lead.dataset.kind = k; lead.textContent = WORDS[k].lead; steps.textContent = WORDS[k].steps; steps.hidden = true; how.setAttribute('aria-expanded', 'false'); }
        } else if (!steps.hidden) { steps.hidden = true; how.setAttribute('aria-expanded', 'false'); }
        if (box.hidden === out) box.hidden = !out;
    };
    const askPi = async () => {
        if (!local || Date.now() - piAskedAt < PI_ASK_GAP_MS) return;
        piAskedAt = Date.now();
        try {
            const r = await serverFetch(server, '/api/system/cli-check?type=pi&signin=1', { cache: 'no-store' });
            const d = r.ok ? await r.json() : null;
            piKnown = d && d.found !== false && typeof d.signed_in === 'boolean' ? d.signed_in : undefined;
        } catch { piKnown = undefined; }
        if (box.isConnected) sync();
    };
    select.addEventListener('change', () => { sync(); if (kind() === 'pi') askPi(); });
    const stop = onSigninChange(() => { if (!box.isConnected) { stop(); return; } sync(); });
    sync();
    if (local) { askSigninSoon(); if (kind() === 'pi') askPi(); } // Claude's status at most 10 s old; Pi's when Pi is the provider
}
