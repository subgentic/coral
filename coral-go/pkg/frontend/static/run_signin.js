/* Recovering from a run that did not start because the agent's CLI is not signed in (#16715, #15848 group 4): the notice's Sign in starts the same local sign-in as Settings > Security > Accounts
   (POST /api/system/cli-signin, #16714), and Retry (the job's own Run now) comes once it is started. Loaded when the button is pressed. Through the Hub the sign-in is on the computer that runs Coral, so it says so. */
import { isCloud } from './server_base.js';

/** The sign-in button of a job's "did not start" notice: starts the CLI's login and shows Retry beside it. */
export async function signInFromRun(btn) {
    const box = btn.closest('.sched-fail-banner'), status = box?.querySelector('.run-signin-status'), retry = box?.querySelector('.run-signin-retry');
    const say = t => { if (status) status.textContent = t; };
    if (isCloud()) { say('Sign in on the computer that runs Coral, then press Retry.'); if (retry) retry.hidden = false; return; }
    btn.disabled = true; say('Starting sign-in...');
    try {
        const r = await fetch(`/api/system/cli-signin?type=${encodeURIComponent(btn.dataset.cli || '')}`, { method: 'POST', cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (j.started) { say('Sign-in started: complete it in the browser that opened, then press Retry.'); if (retry) retry.hidden = false; }
        else say(j.message || 'Could not start sign-in');
    } catch { say('Could not start sign-in'); }
    btn.disabled = false;
}
