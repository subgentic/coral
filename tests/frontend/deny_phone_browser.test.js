// The Deny dialog on a phone (#11621, from #11619): it sat flush against the top left corner of the screen with no margin (the base reset gives every dialog margin 0 and nothing centred this one); it is centred with a side gutter, as
// the other dialogs are, at 390 and at 1280. And the short "Denied ..." toast no longer sits over the artifact viewer's header and version row on a phone: opening the viewer puts away the plain toasts (their words were
// announced), an error or a toast with Undo stays. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 820, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`import(${S} + 'artifact_review.js').then(m => { m.openDenyDialog('t', { name: 'plan.md', id: '${'a'.repeat(64)}', team: 't' }); return true; })`);
            await waitFor(`!!document.querySelector('dialog.inbox-deny-dialog[open]')`, at + 'the Deny dialog opens', 6000);
            const r = await ev(`(() => { const b = document.querySelector('dialog.inbox-deny-dialog').getBoundingClientRect(); return { left: b.left, right: innerWidth - b.right, top: b.top, bottom: innerHeight - b.bottom }; })()`);
            check(r.left >= 8 && r.right >= 8, at + `the dialog has a side gutter of at least 8 px: ${JSON.stringify(r)}`);
            check(r.top >= 8 && r.bottom >= 8 && Math.abs(r.left - r.right) <= 1, at + `the dialog is centred, not in a corner: ${JSON.stringify(r)}`);
            await ev(`document.querySelector('dialog.inbox-deny-dialog .btn:last-child').click(); true`);
        }
        // the toast: on a phone, opening the viewer puts away a plain toast; an error toast stays
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`import(${S} + 'notifications.js').then(m => { m.showToast('Denied plan.md. Writer was told.'); m.showToast('Could not save', true); return true; })`);
        await ev(`import(${S} + 'artifact_viewer.js').then(m => { m.openArtifactViewer('${'b'.repeat(64)}', { filename: 'plan.md' }); return true; })`);
        await waitFor(`!!document.querySelector('.artifact-viewer:not([hidden])') || !!document.querySelector('dialog[open] .artifact-viewer-title')`, 'the viewer opens', 6000).catch(() => {});
        const left = await ev(`[...document.querySelectorAll('#toast-host > .toast')].map(t => t.textContent.trim())`);
        check(!left.some(t => /^Denied/.test(t)) && left.some(t => /Could not save/.test(t)), 'the viewer put away the plain toast and kept the error: ' + JSON.stringify(left));
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('deny_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
