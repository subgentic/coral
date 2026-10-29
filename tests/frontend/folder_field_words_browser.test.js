// The New agent folder field says the folder is on the computer running Coral, and the Browse panel shows the whole current path (#10961 item 7b, the phone pass: a phone's person does not know the path is on the other
// computer, and the path was cut at its end). 390 px; the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev); await stubModels(ev);
        await openNewAgent(ev, waitFor);
        const help = await ev(`(() => { const f = document.getElementById('launch-dir'); const row = f.closest('.sv-row') || f.parentElement.parentElement; return row ? row.innerText.replace(/\\s+/g, ' ') : ''; })()`);
        assert.ok(/A folder on the computer running Coral\./.test(help), 'the folder field says where the folder is: ' + JSON.stringify(help));
        await ev(`document.getElementById('btn-browse').click(); true`);
        await waitFor(`document.getElementById('dir-browser') && getComputedStyle(document.getElementById('dir-browser')).display !== 'none'`, 'the Browse panel', 8000);
        const p = await ev(`(() => { const e = document.getElementById('browser-current-path'); e.textContent = '/Users/someone/Software/a-long-project-name/with/many/nested/folders/and-one-more-deep-folder'; const c = getComputedStyle(e); return { whole: e.scrollWidth <= e.clientWidth + 1, ellipsis: c.textOverflow === 'ellipsis' && c.whiteSpace === 'nowrap', lines: Math.round(e.getBoundingClientRect().height / parseFloat(c.lineHeight || 16)) }; })()`);
        assert.ok(p.whole && !p.ellipsis, 'the Browse panel shows the whole path (wrapped), not cut at its end: ' + JSON.stringify(p));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
