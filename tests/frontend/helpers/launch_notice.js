// A clean profile for a suite that measures the page (#15604): a fresh isolated server has not shown the launch notice ("Agents default to auto mode"), so its banner takes a row, shifts every header below it and adds Tab stops (#15079, #15120). Acknowledge it once through the page, as the person's Continue does, drop the reserved-row hint, and load the page again so it is drawn without it. A suite about the notice itself does not call this.
async function quietLaunchNotice(Page, ev, url) {
    const acked = await ev(`(async () => { const d = await fetch('/api/launch-disclosure').then(r => r.ok ? r.json() : null).catch(() => null); if (!d || d.seen !== false) return false; const r = await fetch('/api/launch-disclosure/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) }); try { localStorage.removeItem('coral-launch-notice'); } catch (e) { /* none */ } return r.ok; })()`);
    if (acked) { await Page.navigate({ url }); await Page.loadEventFired(); }
    return acked;
}
// Takes the acknowledgement back at the suite's end (the owner's DELETE, as phone_landscape_fold does): the suite acknowledged the notice on a shared server and must leave the server as it found it, or --fail-on-leak fails the run (v2.0.65 gate5: font_swap_shift, phone_pass, phone_model_b).
async function restoreLaunchNotice(ev) {
    return ev(`fetch('/api/launch-disclosure/ack', { method: 'DELETE' }).then(r => r.ok)`).catch(() => false);
}
module.exports = { quietLaunchNotice, restoreLaunchNotice };
