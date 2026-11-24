// Coral Live computer controls (#21030), approved mock v2. This unmounted shell has no
// network calls or enabling path. The local controller attaches after its gate check.
// Never put mock frame data, link tokens or agent names into a public preview.
export function createLiveControlsShell({ teamLabel, hubLabel }) {
    const root = document.createElement('section');
    root.className = 'coral-live';
    root.setAttribute('aria-label', 'Coral Live');
    root.innerHTML = `<div class="coral-live-columns"><section><div class="coral-live-eyebrow">Team settings · Coral Live</div><h1>Share a live view of your team</h1><p class="coral-live-muted">A public, read-only page with your team's roles, status, task titles and recent posts.</p>
<div data-live="needs" class="coral-live-card coral-live-needs" hidden><div class="coral-live-row"><h2 class="coral-live-tight" data-live="needs-title">Coral Live is on</h2><span class="coral-live-badge">Stays here while live</span></div><p data-live="needs-copy"></p><small data-live="needs-facts"></small><p class="coral-live-muted">Stopping ends new sharing. What a viewer already copied cannot be recalled.</p><div class="coral-live-actions"><button data-live="needs-open">Review live link</button><button data-stop class="coral-live-danger">Stop sharing now</button></div></div>
<div class="coral-live-card"><div class="coral-live-row coral-live-between"><h2 class="coral-live-tight">Live link</h2><span data-live="state" class="coral-live-status">Not created</span></div>
<div class="notice notice-warn coral-live-notice"><strong>Anyone with the link can read this.</strong><p>Text is checked for secrets on your computer, but checks can miss. Chat includes what you type to the agent and the agent's replies. A viewer may copy what they see.</p></div>
<div class="coral-live-fields"><label class="coral-live-field">Team<select data-live="team"><option></option></select></label><label class="coral-live-field">Share through<select data-live="hub"><option></option></select></label><label class="coral-live-field">Re-confirm after<select data-live="expiry"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label><label class="coral-live-field">Chat delay<select data-live="delay"><option value="30">30 seconds</option><option value="60">1 minute</option></select></label></div>
<p><small>Chat links need one re-confirm every 7 days. For roster and posts, choose a period up to 90 days at this computer. After the grace period, the whole link pauses.</small></p>
<div class="coral-live-section-separator"><h3>Chat · choose one agent</h3><p class="coral-live-muted">Off by default. Only your typed messages and this agent's replies: up to 12 messages from the last 2 minutes, each up to 500 characters, shown at least 30 seconds late.</p><label class="coral-live-check"><input type="checkbox" data-live="chat"><span><strong>Share the selected agent's chat</strong><small>Public label: the selected agent · current session only</small></span></label><p><small>Tool calls, results, thinking, attachments and system messages are excluded. If the agent restarts or resumes, sharing its chat turns off. One re-confirm covers everything this link shows: every 7 days with chat, or 90 days without it. You get a notice before it is due. After the grace period, the whole link pauses. Terminal is not included in this proof.</small></p></div>
<div data-live="changed" class="notice notice-warn coral-live-notice" hidden>Chat selection changed. Read the updated public preview before confirming.</div><div data-live="renew" class="notice notice-warn coral-live-notice" hidden></div>
<div data-live="confirm-wrap" class="coral-live-section-separator" hidden><label class="coral-live-check"><input type="checkbox" data-live="confirm"><span data-live="confirm-text"></span></label></div>
<p data-live="link" hidden>The link is on the Hub page.</p>
<p class="coral-live-muted">Pause hides the public view. Stop ends the link. Resuming requires confirmation at this computer.</p><div class="coral-live-actions" data-live="actions"></div><p data-live="status-line" role="status" aria-live="polite"></p>
</div>
</section><section class="coral-live-preview-column"><div class="coral-live-eyebrow">Public preview</div><h1>Exactly what a viewer sees</h1><p class="coral-live-muted">Read the delayed, checked text before sharing. Held for a short time on Coral’s service.</p><button data-live="load-preview">Load public preview</button><div data-live="public" class="coral-live-public"><p class="coral-live-muted">Load the public preview before confirming.</p></div></section></div>`;
    const field = name => root.querySelector(`[data-live="${name}"]`);
    field('team').replaceChildren(new Option(teamLabel, ''));
    field('hub').replaceChildren(new Option(hubLabel, ''));
    for (const control of root.querySelectorAll('button, input, select')) control.disabled = true;
    field('status-line').textContent = 'Coral Live is not enabled.';
    return { root, field };
}
