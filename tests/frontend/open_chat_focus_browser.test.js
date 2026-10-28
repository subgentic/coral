// Opening an agent's chat puts the keyboard somewhere (#9794, #9783's open item): the chat is the page after Enter on Open chat, so focus is not left on the page body.
// At a mouse the composer has it (the person came to type); on a phone no keyboard pops up, so the chat's heading has it. axName of the focused element says where it is.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280 px, a mouse', 1280, 820, false], ['390 px, a phone', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`window.__m.add('focus-a', 'P', 4, { sleeping: false, session_id: 'focus-a-id' }); true`);
            await ev(`document.body.focus(); import(${S} + 'sessions.js').then(m => m.selectLiveSession('focus-a', 'claude', 'focus-a-id')).then(() => true)`);
            await waitFor(`getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, label + ': the chat shows', 8000);
            const where = await ev(`(() => { const a = document.activeElement; return { id: a && a.id, tag: a && a.tagName, visible: !!a && a.getClientRects().length > 0 }; })()`);
            const want = mobile ? 'session-name' : 'command-input';
            await waitFor(`document.activeElement && document.activeElement.id === '${want}'`, `${label}: focus is on #${want}, not ${JSON.stringify(where)}`, 4000);
            await ev(`document.activeElement.setAttribute('data-ax-probe', ''); true`);
            const ax = await axName(client, '[data-ax-probe]');
            assert.ok(ax && ax.name !== undefined && (mobile ? ax.role === 'heading' : /textbox|combobox/.test(ax.role)), `${label}: the focused element is named ${JSON.stringify(ax)}`);
            console.log('PASS ' + label + ': focus is on ' + want);
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
