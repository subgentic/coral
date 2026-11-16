/* The notice on a scheduled job whose last run did not start because the agent's CLI is not signed in (#16715, #15848 group 4). It is drawn here, when the job is opened, so none of it is in the start path.
   Where the CLI has a local login (Claude, #16714) it has Sign in, which starts the same login as Settings > Security > Accounts (POST /api/system/cli-signin), and then Retry, the job's own Run now.
   A timeout keeps its own words and has no button; a CLI with no local login (Codex, Pi, one this build does not know) keeps the neutral hint. Through the Hub the login is on the computer that runs Coral. */
import { runFailure } from './run_failure.js';
import { escapeHtml } from './utils.js';
import { isCloud } from './server_base.js';
import { loadStyles } from './lazy_styles.js';

/** Fill the job's slot with the notice for its last run `rec`, and the way to recover where there is one. */
export async function signedOutNotice(slot, rec, jobId) {
    const f = runFailure(rec);
    if (!slot || !f) return;
    await loadStyles('run_signin.css');
    if (!slot.isConnected) return;
    const can = rec.error_code === 'not_signed_in' && rec.agent_type === 'claude';
    slot.className = 'notice notice-error sched-fail-banner';
    slot.setAttribute('role', 'status');
    slot.innerHTML = `<div class="sched-fail-text"><strong>The last run did not start: ${escapeHtml(f.text)}.</strong> ${escapeHtml(f.hint)} This job keeps its schedule and ${escapeHtml(f.again)}.` +
        (can ? `<div class="run-signin-actions"><button type="button" class="btn btn-small btn-primary run-signin" aria-label="Sign in to Claude">Sign in</button> <button type="button" class="btn btn-small run-signin-retry" data-on-click="job-run-now" data-job-id="${Number(jobId)}" hidden>Retry</button> <span class="run-signin-status settings-hint" role="status"></span></div>` : '') + '</div>';
    const btn = slot.querySelector('.run-signin');
    if (!btn) return;
    const status = slot.querySelector('.run-signin-status'), retry = slot.querySelector('.run-signin-retry');
    btn.addEventListener('click', async () => {
        if (isCloud()) { status.textContent = 'Sign in on the computer that runs Coral, then press Retry.'; retry.hidden = false; return; }
        btn.disabled = true; status.textContent = 'Starting sign-in...';
        try {
            const j = await (await fetch('/api/system/cli-signin?type=claude', { method: 'POST', cache: 'no-store' })).json().catch(() => ({}));
            if (j.started) { status.textContent = 'Sign-in started: complete it in the browser that opened, then press Retry.'; retry.hidden = false; }
            else status.textContent = j.message || 'Could not start sign-in';
        } catch { status.textContent = 'Could not start sign-in'; }
        btn.disabled = false;
    });
}
