// Beta's Settings pass (#10725, #10735): the CLI path fields say they want a full path (a placeholder of just "claude" looks already filled in), the theme list names Dark once even when a saved custom
// theme is also called Dark, and Close with a change not saved opens its Discard dialog on the first click. Real isolated server; the saved themes list is stood in for. 1280 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a real pointer press has no completion event to wait on
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).split('?')[0] === '/api/themes' ? Promise.resolve(new Response(JSON.stringify({ themes: [{ name: 'Dark' }, { name: 'Obsidian' }] }), { headers: { 'Content-Type': 'application/json' } })) : f(u, o); return true; })()`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`!!document.getElementById('settings-theme') && document.getElementById('settings-theme').options.length > 3`, 'the theme list with the saved themes', 15000);
        console.log('1. the theme list names Dark once');
        const labels = await ev(`[...document.getElementById('settings-theme').options].filter(o => !o.disabled).map(o => o.textContent)`);
        assert.deepEqual(labels, ['Dark', 'Light', 'System', 'Dark (custom)', 'Obsidian'], 'a saved theme named Dark stays in the list as Dark (custom), so its owner can pick or delete it (#10787): ' + JSON.stringify(labels));
        assert.equal(await ev(`[...document.getElementById('settings-theme').options].find(o => o.textContent === 'Dark (custom)').value`), 'custom:Dark');
        console.log('2. a CLI path field says it wants a full path');
        const ph = await ev(`['claude', 'codex', 'agy', 'pi'].map(t => document.getElementById('settings-cli-path-' + t).placeholder)`);
        const win = await ev(`/^win/i.test(navigator.userAgentData?.platform || navigator.platform || '')`); // a Windows path on Windows (#10787)
        for (const [i, t] of ['claude', 'codex', 'agy', 'pi'].entries()) assert.ok(ph[i].startsWith(`Full path, e.g. ${win ? `C:\\Program Files\\${t}\\${t}.exe` : `/usr/local/bin/${t}`}`), `${t}: ${ph[i]}`);
        console.log('3. Close with a change not saved opens the Discard dialog on the first click');
        await ev(`(() => { const s = document.getElementById('settings-theme'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const at = await ev(`(() => { const b = document.getElementById('settings-cancel-btn').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: at.x, y: at.y });
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await sleep(150); // sleep-ok: the dialog must be there this soon after one click; that is the thing asserted
        const asked = await ev(`/Discard unsaved changes/.test(document.body.innerText) && [...document.querySelectorAll('.modal')].some(m => getComputedStyle(m).display !== 'none' && /Discard unsaved changes/.test(m.innerText))`);
        assert.ok(asked, 'the Discard dialog is on screen 150 ms after one click');
        console.log('PASS the first look at Settings');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
