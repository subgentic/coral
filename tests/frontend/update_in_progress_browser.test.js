// While an update installs the dialog says so, and the page that comes back says "Coral is now X" (#10834 fix 3, the operator: the in-app update is very bad). Before: one static "Coral is quitting" line and
// nothing when the new Coral was up. 1280 px; a stubbed status and relaunch on the isolated dev server (the reload itself is not driven: the stub would not survive it).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const READY = { enabled: true, installed: '1.0.0', state: 'staged', staged: { version: '9.9.9', staged_at: new Date().toISOString(), days_ready: 0, verified: true }, relaunch: { available: true, reason: '', restarts: [], ack: 'a' } };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`try { sessionStorage.removeItem('coral-updated-to'); } catch (e) {} (() => { window.__st = ${JSON.stringify(READY)}; const R = window.fetch.bind(window); window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname; const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })); if (p === '/api/system/update') return j(window.__st); if (p === '/api/system/update/relaunch-local') return j({ ok: true }, 202); return R(u, o); }; return true; })()`);
        await ev(`import(${S} + 'update_ui.js').then(async m => { await m.refreshUpdateStatus(); const d = await import(${S} + 'update_dialog.js'); d.openUpdateDialog(m.getUpdateStatus()); return true; })`);
        await waitFor(`!!document.querySelector('#update-confirm-modal .update-go')`, 'the confirmation', 6000);
        await ev(`document.querySelector('#update-confirm-modal .update-go').click(); true`);
        await waitFor(`!!document.querySelector('#update-confirm-modal .update-updating')`, 'the updating line', 6000);
        const t = await ev(`document.querySelector('#update-confirm-modal .update-updating').textContent`);
        assert.match(t, /Updating Coral to 9\.9\.9.*comes back by itself/, t);
        assert.equal(await ev(`sessionStorage.getItem('coral-updated-to')`), '9.9.9', 'the version it goes to is kept for the page that comes back');
        // the page that comes back: the new Coral answers as 9.9.9
        await ev(`window.__st = { ...window.__st, installed: '9.9.9', state: 'none', staged: null }; document.querySelectorAll('.toast').forEach(e => e.remove()); import(${S} + 'update_ui.js').then(m => m.refreshUpdateStatus()).then(() => true)`);
        await waitFor(`/Coral is now 9\\.9\\.9/.test(document.body.innerText)`, 'the Coral is now line', 6000);
        assert.equal(await ev(`sessionStorage.getItem('coral-updated-to')`), null, 'said once');
        // a refused install ends with something to do: the button is back and a download link says so
        await ev(`window.__st = ${JSON.stringify(READY)}; (() => { const R = window.fetch; window.fetch = (u, o) => String(u).endsWith('/relaunch-local') ? Promise.resolve(new Response(JSON.stringify({ code: 'updater_not_started' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : R(u, o); })(); import(${S} + 'update_ui.js').then(async m => { await m.refreshUpdateStatus(); const d = await import(${S} + 'update_dialog.js'); d.openUpdateDialog(m.getUpdateStatus()); return true; })`);
        await waitFor(`!!document.querySelector('#update-confirm-modal .update-go')`, 'the confirmation again', 6000);
        await ev(`document.querySelector('#update-confirm-modal .update-go').click(); true`);
        await waitFor(`!!document.querySelector('#update-confirm-modal .update-error')`, 'the refusal', 6000);
        const f = await ev(`(() => { const e = document.querySelector('#update-confirm-modal .update-error'); const a = e.querySelector('a'); return { text: e.textContent, href: a && a.href, again: !document.querySelector('#update-confirm-modal .update-go').disabled }; })()`);
        assert.ok(/Download Coral 9\.9\.9 yourself/.test(f.text) && /github\.com\/subgentic\/coral\/releases\/latest$/.test(f.href) && f.again, 'a failure has the way on: ' + JSON.stringify(f));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
