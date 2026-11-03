// When the ids show the data folder may be a copy of another Coral's, Coral runs as usual and the dashboard shows one warning with "This is my data folder" (#12591). The button adopts the folder in place
// (POST /api/system/data-folder/adopt): the warning goes when that worked, and says so and stays when it did not. With nothing to say there is no warning. Drives Chrome over CDP against the dev server;
// the status answer and the adopt route are scripted at page start.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

const STUB = `(() => {
    window.__adopts = 0; window.__adoptStatus = 500;
    const real = window.fetch;
    window.fetch = async (u, o = {}) => {
        const p = new URL(String(u), location.href), m = o.method || 'GET';
        if (p.pathname === '/api/system/status' && localStorage.getItem('stub-warning') === '1') {
            const r = await real(u, o), d = await r.clone().json().catch(() => null);
            if (!d) return r;
            d.data_folder_warning = 'This database carries an id that does not match this data folder, so it may be a copy of another Coral\\'s. Coral is running as usual.';
            return new Response(JSON.stringify(d), { status: r.status, headers: { 'content-type': 'application/json' } });
        }
        if (p.pathname === '/api/system/data-folder/adopt' && m === 'POST') {
            window.__adopts++;
            return new Response(JSON.stringify({ adopted: window.__adoptStatus === 200 }), { status: window.__adoptStatus, headers: { 'content-type': 'application/json' } });
        }
        return real(u, o);
    };
})();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

        // nothing to say: no warning
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup');
        await nextFrame(ev);
        assert.equal(await ev(`!!document.getElementById('data-folder-warning-toast')`), false, 'no warning when the ids do not show a copy');

        // a copy: the warning and its one button
        await ev(`localStorage.setItem('stub-warning', '1'); true`);
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await waitFor(`!!document.getElementById('data-folder-warning-toast')`, 'the data folder warning');
        const read = () => ev(`(() => { const t = document.getElementById('data-folder-warning-toast'); if (!t) return null; const b = t.querySelector('.update-toast-action'); const e = t.querySelector('.update-toast-action-error'); return { text: t.querySelector('.security-warning-text').textContent, button: b && b.textContent, disabled: b && b.disabled, error: e && !e.hidden ? e.textContent : '' }; })()`);
        let w = await read();
        assert.match(w.text, /may be a copy/);
        assert.match(w.text, /running as usual/, 'it says Coral is not waiting');
        assert.equal(w.button, 'This is my data folder');
        assert.equal(w.error, '');

        // the adopt fails: the warning stays, the button works again, and it says so
        await ev(`document.querySelector('#data-folder-warning-toast .update-toast-action').click(); true`);
        await waitFor(`window.__adopts === 1 && document.querySelector('#data-folder-warning-toast .update-toast-action-error') && !document.querySelector('#data-folder-warning-toast .update-toast-action-error').hidden`, 'the failure said');
        w = await read();
        assert.ok(w, 'the warning stays after a failed adopt');
        assert.equal(w.disabled, false, 'the button can be pressed again');
        assert.match(w.error, /did not work/);

        // it works: the warning goes
        await ev(`window.__adoptStatus = 200; document.querySelector('#data-folder-warning-toast .update-toast-action').click(); true`);
        await waitFor(`!document.getElementById('data-folder-warning-toast')`, 'the warning to go once adopted');
        assert.equal(await ev(`window.__adopts`), 2);
    } finally { await client.close(); }
    console.log('data_folder_warning_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
