// Pressing Launch by keyboard lands the keyboard in the new agent's message box (#10247, the first run walked by keyboard): the dialog closed, the agent opened, and the keyboard was left on the button that opened
// the dialog (on a phone, where that button is gone, on the page), so the person had to Tab the whole way round to type. Now it is in the message box; when the person has moved the keyboard somewhere else while the
// agent was opening it stays there. _openLaunched is what Launch calls once the agent is in the list. At 1280 and 640 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const S = `(window.__coralStatic || '/static/')`;
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : ''); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [640, 400]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await ev(`(() => { document.getElementById('kb-opener')?.remove(); const b = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'kb-opener', textContent: 'New agent' })); b.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999'; return true; })()`);
            for (const [label, setup, want] of [
                ['the keyboard is on the button that opened the dialog', `document.getElementById('kb-opener').focus()`, 'textarea#command-input'],
                ['the opener is gone (a phone) and the keyboard is on the page', `document.getElementById('kb-opener').focus(); document.getElementById('kb-opener').blur()`, 'textarea#command-input'],
                ['the person has moved the keyboard to something else', `document.getElementById('kb-other').focus()`, 'button#kb-other'],
            ]) {
                await ev(`(() => { window.__m.add('coral-go', 'm', 4, { sleeping: false, session_id: 'o1' }); document.getElementById('kb-other')?.remove(); const o = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'kb-other', textContent: 'other' })); o.style.cssText = 'position:fixed;left:8px;top:48px;z-index:99999'; return true; })()`);
                await ev(`${setup}; true`);
                await ev(`import(${S} + 'launch_dialog.js').then(m => m._openLaunched({ session_name: 'coral-go', session_id: 'o1' }, 'claude', document.getElementById('kb-opener'))).then(() => true)`);
                await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, `${w}: the agent's message box`, 10000);
                const got = await where();
                check(got === want, `${label}: after the agent opens the keyboard is on ${want} (it is on ${got})`);
                await ev(`window.exitLiveSession && window.exitLiveSession(); true`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the keyboard after Launch:\n  ' + problems.join('\n  '));
    console.log('PASS the keyboard lands in the new agent\'s message box after Launch');
})().catch(e => { console.error(e); process.exit(1); });
