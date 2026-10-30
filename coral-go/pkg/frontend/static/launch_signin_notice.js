/* New Agent's Agent step says so, above the provider cards, when the provider is Claude and Claude is not signed in on this computer (#11336, QA's desktop pass: it was one small grey line behind the dialog that never said how to sign in).
 * A notice under the provider, not a block: Launch stays on, because the status can be minutes old and the agent's own chat shows "Sign-in needed" with Open terminal and Check again the moment it needs it
 * (needs_input_card.js). "How to sign in" opens the steps; a person who signs in first does not need the card. */
import { claudeSignedIn, askSigninSoon, onSigninChange } from './signin_line.js';
import { LOCAL_SERVER, normServer } from './server_base.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function mountLaunchSigninNotice({ slot, before, form, server }) {
    const select = form && form.querySelector('.acf-agent-type');
    if (!slot || !select) return;
    const host = (before || slot).parentNode; // `before`: the Provider heading, so the notice is the first thing in the section; the slot is at the end of the Agent pane, below the cards, out of sight
    host.querySelector('.launch-signin-notice')?.remove(); // a new dialog draws its own
    const box = el('div', 'notice notice-warn notice-compact launch-signin-notice'); box.hidden = true; box.setAttribute('role', 'status');
    const icon = el('span', 'material-icons', 'info'); icon.setAttribute('aria-hidden', 'true');
    const body = el('div', 'launch-signin-body');
    const lead = el('p', 'launch-signin-lead', "Claude isn't signed in on this computer.");
    const how = el('button', 'btn btn-sm launch-signin-how', 'How to sign in'); how.type = 'button'; how.setAttribute('aria-expanded', 'false');
    const steps = el('p', 'launch-signin-steps', 'Open a terminal, run claude and follow the steps. Or launch now: the agent’s chat then shows Open terminal and Check again.'); steps.hidden = true; steps.id = `${slot.id || 'launch'}-signin-steps`;
    how.setAttribute('aria-controls', steps.id);
    how.addEventListener('click', () => { steps.hidden = !steps.hidden; how.setAttribute('aria-expanded', String(!steps.hidden)); });
    body.append(lead, how, steps); box.append(icon, body);
    if (before) before.before(box); else slot.after(box);
    const sync = () => {
        const on = claudeSignedIn() === false && (select.value || 'claude') === 'claude' && normServer(server) === LOCAL_SERVER;
        if (box.hidden === on) box.hidden = !on;
        if (!on && !steps.hidden) { steps.hidden = true; how.setAttribute('aria-expanded', 'false'); }
    };
    select.addEventListener('change', sync);
    const stop = onSigninChange(() => { if (!box.isConnected) { stop(); return; } sync(); });
    sync();
    askSigninSoon(); // a status at most 10 s old
}
