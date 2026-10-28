// Dropping a file that is not an image on the chat says what to do (#10147, the Desktop tester: a dropped text file did nothing a person could see): "Only images can be attached here; mention a project file with @". A dropped image is
// still taken (attach_image_browser covers it). 1280 px, isolated dev server, the harness's stand-in agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.__m.add('drop-bot', 'A', 3, { sleeping: false, session_id: 'drop-bot-id' }); true`);
        await waitFor(`(window._coralGetLiveSessions ? window._coralGetLiveSessions() : []).some(s => s.session_id === 'drop-bot-id')`, 'the agent', { timeout: 8000 });
        await ev(`window.selectLiveSession('drop-bot', 'claude', 'drop-bot-id', 'local'); true`);
        await waitFor(`!!document.getElementById('command-pane') && document.getElementById('command-pane').getClientRects().length > 0`, 'the composer', { timeout: 8000 });
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' })); document.getElementById('command-pane').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
        await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Only images can be attached here/.test(t.textContent) && /@/.test(t.textContent))`, 'a toast that says only images can be attached and to mention a project file with @', { timeout: 6000 });
        assert.match(await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')`), /Mention it with @notes\.txt\./, 'it names the file: the next step in one sentence (#10311)');
        // the same drop reaching two nested elements says it once
        await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' })); const init = { bubbles: true, cancelable: true, dataTransfer: dt }; document.getElementById('command-input').dispatchEvent(new DragEvent('drop', init)); document.getElementById('command-pane').dispatchEvent(new DragEvent('drop', init)); return true; })()`);
        assert.equal(await ev(`[...document.querySelectorAll('.toast')].filter(t => /Only images can be attached here/.test(t.textContent)).length`), 1, 'one toast, not two');
        assert.equal(await ev(`document.querySelectorAll('#image-attachments .image-attachment').length`), 0, 'nothing was attached');
        console.log('PASS a dropped file that is not an image says what to do');
    } finally { await client.close(); }
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
