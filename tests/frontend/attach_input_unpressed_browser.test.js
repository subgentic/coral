// A file set on the attach input shows its thumbnail chip whether or not the Add image button was pressed first (#10512, Desktop recheck: the file chooser path, files.length 1, left the image box hidden). The
// change handler used to be bound by the button's first press, so a file given to the input any other way (a file chooser that is not the button's, a test, a drag from the OS onto the input) was never taken.
// The upload is stood in at POST /api/upload; a stand-in agent in the page. 1280 px, isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const dir = fs.mkdtempSync('/tmp/att-'), file = `${dir}/picked.png`;
    fs.writeFileSync(file, PNG);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const url = String(u && u.url || u);
            if (url.endsWith('/api/upload') && (o.method || 'GET').toUpperCase() === 'POST') return Promise.resolve(new Response(JSON.stringify({ path: '/tmp/picked.png', filename: 'picked.png' }), { headers: { 'content-type': 'application/json' } }));
            return real(u, o); }; window.__m.add('att-a', 'A', 1, { sleeping: false }); return true; })()`);
        await ev(`window.selectLiveSession('att-a', 'claude', 'att-a-id', 'local'); true`);
        await waitFor(`!!window.T && T.state.currentSession && T.state.currentSession.session_id === 'att-a-id' && !!document.getElementById('attach-image-input')`, 'the agent is open', 15000);
        assert.equal(await ev(`getComputedStyle(document.getElementById('image-attachments')).display`), 'none', 'no chip row before a file is given');
        await client.DOM.enable();
        const { root } = await client.DOM.getDocument();
        const { nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector: '#attach-image-input' });
        await client.DOM.setFileInputFiles({ files: [file], nodeId }); // the file is given to the input directly: the Add image button was not pressed
        await waitFor(`document.querySelectorAll('#image-attachments .image-attachment').length === 1 && getComputedStyle(document.getElementById('image-attachments')).display !== 'none'`, 'the thumbnail chip', 8000);
        console.log('PASS A file set on the attach input shows its chip');
    } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
