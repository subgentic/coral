// Open folder (#10572, Beta Home cards pass #10552): the "Type a folder, or Browse to one." line goes as soon as the box has a folder, typed or chosen with Browse (it stayed up over a filled box), and Browse
// starts in the person's home folder (what the server calls "~"), not where an earlier visit left it. 1280 px, isolated dev server. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'pinned_folders.js'); m.showOpenFolderModal(); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('open-folder-modal')).display !== 'none'`, 'the dialog', 4000);
        const err = () => ev(`(() => { const e = document.getElementById('open-folder-error'); return e.hidden ? '' : e.textContent; })()`);
        // empty: the line says what to do; typing clears it
        await ev(`document.getElementById('open-folder-submit').click(); true`);
        if (!/Type a folder/.test(await err())) problems.push('an empty box says Type a folder: ' + await err());
        await ev(`{ const i = document.getElementById('open-folder-dir'); i.focus(); i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } true`);
        if (await err()) problems.push('typing a folder clears the line (it says: ' + await err() + ')');
        // empty again, then a folder chosen with Browse (the browser sets the box and fires change)
        await ev(`{ const i = document.getElementById('open-folder-dir'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('open-folder-submit').click(); } true`);
        if (!/Type a folder/.test(await err())) problems.push('an empty box says it again: ' + await err());
        // Browse starts at the home folder and puts it in the box: the line goes with it
        await ev(`document.getElementById('open-folder-browse').click(); true`);
        const home = await ev(`fetch('/api/filesystem/list?path=' + encodeURIComponent('~')).then(r => r.json()).then(d => d.path)`);
        await waitFor(`document.getElementById('open-folder-browser-path').textContent === ${JSON.stringify(home)}`, 'Browse at the home folder', 6000).catch(async () => problems.push(`Browse starts in the home folder ${home} (it shows ${await ev(`document.getElementById('open-folder-browser-path').textContent`)})`));
        if (await err()) problems.push('a folder chosen with Browse clears the line (it says: ' + await err() + ')');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Open folder:\n  ' + problems.join('\n  '));
    console.log('PASS Open folder: the error clears when the box is filled, Browse starts at home');
})().catch(e => { console.error(e); process.exit(1); });
