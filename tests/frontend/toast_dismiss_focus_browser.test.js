// The keyboard goes back to where it came from when a toast it is on goes away (#10247, the first run walked by keyboard): the offer of desktop alerts is Tab-reachable, and its Dismiss (or its action, or
// the toast timing out) used to leave the keyboard on the body, where the next Tab starts again at the top of the page. Now it is back on the control the person came from; a toast that goes while the keyboard is
// elsewhere leaves it there. At 1280 and 640 px. Drives Chrome over CDP through agent_view_harness.js; the real showToast.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    const S = `(window.__coralStatic || '/static/')`;
    const where = () => ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'the page (nothing)' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + ' ' + (a.className || '').toString().slice(0, 30); })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[1280, 800], [640, 400]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${w}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`document.getElementById('kb-from')?.remove(); const b = document.body.appendChild(Object.assign(document.createElement('button'), { id: 'kb-from', textContent: 'where the keyboard was' })); b.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999'; true`);
            const show = (action, duration) => ev(`import(${S} + 'notifications.js').then(m => { m.showToast('Get an alert when an agent needs you?', false, ${duration === undefined ? 'undefined' : duration}, ${action ? `{ action: { label: 'Turn on alerts', onClick: () => {} } }` : '{}'}); return true; })`);
            const cameFrom = sel => ev(`(() => { document.getElementById('kb-from').focus(); const t = document.querySelector(${JSON.stringify(sel)}); t.focus(); return document.activeElement === t; })()`);
            // Dismiss
            await show(true);
            check(await cameFrom('.toast .toast-close'), 'the toast\'s Dismiss takes the keyboard');
            await ev(`document.querySelector('.toast .toast-close').click(); true`);
            check((await where()).trim() === 'button#kb-from', `after Dismiss the keyboard is back where it came from (it is on ${await where()})`);
            // the action
            await show(true);
            check(await cameFrom('.toast .toast-action'), 'the toast\'s action takes the keyboard');
            await ev(`document.querySelector('.toast .toast-action').click(); true`);
            check((await where()).trim() === 'button#kb-from', `after the action the keyboard is back where it came from (it is on ${await where()})`);
            await ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
            // Escape on the toast
            await show(false, 60000);
            check(await cameFrom('.toast .toast-close'), 'a plain toast\'s Dismiss takes the keyboard');
            await ev(`document.querySelector('.toast').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
            check((await where()).trim() === 'button#kb-from', `after Escape the keyboard is back where it came from (it is on ${await where()})`);
            // timing out while the keyboard is on it
            await show(false, 700);
            check(await cameFrom('.toast .toast-close'), 'a timed toast\'s Dismiss takes the keyboard');
            await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the toast's own 700 ms
            check((await where()).trim() === 'button#kb-from', `after the toast timed out the keyboard is back where it came from (it is on ${await where()})`);
            // a toast that goes while the keyboard is elsewhere leaves it there
            await show(true);
            await ev(`document.getElementById('kb-from').focus(); document.querySelector('.toast .toast-close').click(); true`);
            check((await where()).trim() === 'button#kb-from', `a toast dismissed with the mouse leaves the keyboard where it was (it is on ${await where()})`);
            await ev(`document.getElementById('kb-from').remove(); document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the keyboard and a toast that goes away:\n  ' + problems.join('\n  '));
    console.log('PASS the keyboard goes back to where it came from when a toast goes away');
})().catch(e => { console.error(e); process.exit(1); });
