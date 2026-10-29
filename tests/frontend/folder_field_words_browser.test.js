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
        // New project step 1 and the job form say it too, in the same words (#11015, 7b)
        const rowText = id => ev(`(() => { const f = document.getElementById(${JSON.stringify(id)}); const row = f && (f.closest('.sv-row') || f.parentElement.parentElement); return row ? row.innerText.replace(/\\s+/g, ' ') : ''; })()`);
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); (async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
        await waitFor(`!!document.getElementById('launch-team-dir') && document.getElementById('launch-team-dir').getClientRects().length > 0`, 'New project step 1', 8000);
        assert.ok(/A folder on the computer running Coral\./.test(await rowText('launch-team-dir')), 'New project step 1 says where the folder is: ' + JSON.stringify(await rowText('launch-team-dir')));
        await ev(`window.hideLaunchModal && window.hideLaunchModal(); window.showJobModal(); true`);
        await waitFor(`!!document.getElementById('job-modal-repo') && document.getElementById('job-modal-repo').getClientRects().length > 0`, 'the job form', 8000);
        assert.ok(/A folder on the computer running Coral\./.test(await rowText('job-modal-repo')), 'the job form says where the folder is: ' + JSON.stringify(await rowText('job-modal-repo')));
        assert.ok(/git folder with at least one commit/.test(await rowText('job-modal-repo')), 'and keeps its git hint');
        await ev(`window.hideJobModal && window.hideJobModal(); (async () => { await window.showLaunchModal(); window._selectLaunchType('agent'); return true; })()`);
        await waitFor(`!!document.getElementById('btn-browse') && document.getElementById('btn-browse').getClientRects().length > 0`, 'New agent again', 8000);
        await ev(`document.getElementById('btn-browse').click(); true`);
        await waitFor(`document.getElementById('dir-browser') && getComputedStyle(document.getElementById('dir-browser')).display !== 'none'`, 'the Browse panel', 8000);
        const p = await ev(`(() => { const e = document.getElementById('browser-current-path'); e.textContent = '/Users/someone/Software/a-long-project-name/with/many/nested/folders/and-one-more-deep-folder'; const c = getComputedStyle(e); return { whole: e.scrollWidth <= e.clientWidth + 1, ellipsis: c.textOverflow === 'ellipsis' && c.whiteSpace === 'nowrap', lines: Math.round(e.getBoundingClientRect().height / parseFloat(c.lineHeight || 16)) }; })()`);
        assert.ok(p.whole && !p.ellipsis, 'the Browse panel shows the whole path (wrapped), not cut at its end: ' + JSON.stringify(p));
        console.log('PASS');
    } finally { try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
