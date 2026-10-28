// A card's Open terminal puts the keyboard in the terminal (#10247, decided on the first run by keyboard: that is where the person goes to answer): the keyboard used to drop to the page, and the person had to Tab
// into the terminal, which holds Tab. The terminal is built after its view shows, so the input is waited for; a screen reader is told once how to leave (Ctrl+Shift+Escape). At 1280 and 640 px. Drives Chrome over
// CDP through agent_view_harness.js; the terminal's input is stood in by a textarea named as the real one is (xterm_renderer.js), made a moment after showTerminalView.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [640, 400]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`(() => { document.getElementById('kb-card')?.remove(); document.getElementById('kb-term')?.remove();
                const card = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'kb-card', textContent: 'Open terminal' })); card.dataset.onClick = 'terminal-view-open'; card.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999';
                window.showTerminalView = () => { setTimeout(() => { const t = document.body.appendChild(Object.assign(document.createElement('textarea'), { id: 'kb-term' })); t.setAttribute('aria-label', "Terminal: what you type goes straight to the agent's shell"); t.style.cssText = 'position:fixed;left:8px;top:60px;width:200px;height:40px;z-index:99999'; }, 400); };
                card.focus(); return true; })()`);
            await ev(`document.getElementById('kb-card').click(); true`);
            await waitFor(`document.activeElement && document.activeElement.id === 'kb-term'`, `${w}: the keyboard in the terminal`, 6000).catch(async () => check(false, 'after Open terminal the keyboard is in the terminal (it is on ' + await ev(`document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id : 'nothing'`) + ')'));
            const said = await ev(`(document.getElementById('coral-prompt-live') || {}).textContent || ''`);
            check(/Ctrl\+Shift\+Escape/.test(said), 'a screen reader is told once how to leave the terminal: ' + JSON.stringify(said));
            await ev(`document.getElementById('kb-card').remove(); document.getElementById('kb-term') && document.getElementById('kb-term').remove(); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'Open terminal and the keyboard:\n  ' + problems.join('\n  '));
    console.log('PASS Open terminal puts the keyboard in the terminal and says how to leave it');
})().catch(e => { console.error(e); process.exit(1); });
