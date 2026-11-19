// #19788 (the Operator, in the native app: "The button to move an artifact preview to the middle screen is broken."): the dock button in the preview's header (a side-panel icon) moves the preview from the
// bottom of the side panel to its own column in the middle; on the app's own window (1200 x 800) and on smaller ones it must do that, not nothing. Real isolated server, a mock agent, a real click.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { framesJs, coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const state = () => ev(`(() => { const col = document.getElementById('preview-column'), pane = document.getElementById('preview-pane'), b = document.getElementById('preview-dock-btn'); const r = pane.getBoundingClientRect(), lb = document.querySelector('.live-body').getBoundingClientRect();
        return { inColumn: pane.parentElement === col, colShown: getComputedStyle(col).display !== 'none' && col.getBoundingClientRect().width > 100, paneW: Math.round(r.width), paneH: Math.round(r.height), body: Math.round(lb.width), title: b.title, saved: localStorage.getItem('coral-preview-pane-dock') }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const open = async (w, h, saved) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await ev(`localStorage.clear(); ${saved === undefined ? '' : `localStorage.setItem('coral-preview-column-width', ${JSON.stringify(String(saved))});`} true`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        await ev(`(async () => { const st = ${S}; const { state } = await import(st + 'state.js'); window.PP = await import(st + 'preview_pane.js'); const { showView } = await import(st + 'utils.js');
            { const real = window.fetch; window.fetch = (u, o) => /\\/api\\/artifacts\\/a{64}/.test(String(u)) ? Promise.resolve(new Response('# Release notes\\n\\nThe preview shows a **markdown** artifact: a heading, a paragraph and a list.\\n\\n- one\\n- two\\n- three\\n', { status: 200, headers: { 'content-type': 'text/markdown' } })) : real(u, o); } // the artifact the pane shows
            window.__m.add('pv-a', 'P', 4, { sleeping: false, session_id: 'pv-a-id' });
            state.currentSession = { type: 'live', name: 'pv-a', session_id: 'pv-a-id', agent_type: 'claude' }; showView('live-session-view');
            window.PP.setPreviewSession('pv-a-id'); // the agent's own tabs, as selecting it does
            window.PP.openArtifactTab('coral://artifacts/' + 'a'.repeat(64), { name: 'a.md', mediaType: 'text/markdown' }); if (document.getElementById('preview-pane').classList.contains('preview-phone-full')) document.getElementById('preview-full-back').click(); return true; })()`); // a phone opens it full screen (#7652): these checks start from the docked sheet and test the full-screen toggle from there
        await waitFor(`getComputedStyle(document.getElementById('preview-pane')).display !== 'none'`, 'the preview pane', 8000);
    };
        for (const [w, h] of [[1200, 800], [1100, 800], [1000, 760]]) {
            await open(w, h);
            const before = await state();
            assert.equal(before.inColumn, false, `${w}: the preview starts at the bottom of the side panel: ${JSON.stringify(before)}`);
            await shot(`dock-before-${w}`);
            await ev(`document.getElementById('preview-dock-btn').click(); true`);
            await ev(framesJs(2));
            const after = await state();
            await shot(`dock-after-${w}`);
            assert.ok(after.inColumn && after.colShown, `${w}: the button moves the preview to the middle column (${JSON.stringify(after)})`);
            assert.ok(/bottom of the side panel/.test(after.title), `${w}: and the button now offers the way back: ${after.title}`);
            await ev(`document.getElementById('preview-dock-btn').click(); true`); await ev(framesJs(2));
            assert.equal((await state()).inColumn, false, `${w}: the same button puts it back at the bottom`);
        }
        console.log('PASS the preview dock button moves the preview to the middle at 1200, 1100 and 1000 px, and back');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
