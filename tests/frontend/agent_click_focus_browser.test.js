// Opening an agent from the Agents sidebar or the Agents tab puts the cursor in its message box (#15958): a mouse click on a row, and a click on the Agents tab that
// brings the selected agent back. Not on a phone (no keyboard pop-up), not when the click was on a button in the row. Isolated dev server, mock agents.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw settles over frames; there is no completion event
    const active = () => ev(`(document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)) || ''`);
    const clickAt = async (sel, where) => {
        const p = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        assert.ok(p, 'found ' + sel);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: p.x, y: p.y });
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    };
    const rowSel = n => `#live-sessions-list .session-group-item[data-name="${n}-bot"]`;
    const setup = async (w, h, mobile) => {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await ev(`for (const n of ['alpha', 'beta']) window.__m.add(n + '-bot', 'A', 4, { sleeping: false }); true`);
        await ev(`Promise.all([import((window.__coralStatic || '/static/') + 'render.js'), import((window.__coralStatic || '/static/') + 'state.js')]).then(([r, st]) => { r.renderLiveSessions(st.state.liveSessions); return true; })`);
        await waitFor(`document.querySelectorAll('[data-on-click="session-open"][data-session-id]').length >= 1`, 'the rows (' + w + ')');
    };
    try {
        await setup(1440, 900, false);
        // 1. a click on a row: the message box has the cursor once the agent shows, and keeps it through the list's redraws
        await clickAt(rowSel('alpha'));
        await waitFor(`document.getElementById('session-name') && /alpha/.test(document.getElementById('session-name').textContent)`, 'alpha is open', 8000);
        await waitFor(`document.activeElement && document.activeElement.id === 'command-input'`, 'a click on a row puts the cursor in the message box: ' + await active(), 8000);
        await sleep(600); // sleep-ok: the list's redraw and the chat's first paint follow the click; there is no completion event
        assert.equal(await active(), 'command-input', 'the message box keeps the cursor after the redraws');
        // 2. a click on a button inside a row (its menu) does not take the cursor into the message box
        await clickAt(rowSel('beta'));
        await waitFor(`/beta/.test(document.getElementById('session-name').textContent) && document.activeElement.id === 'command-input'`, 'beta open with the cursor in its box');
        await ev(`document.getElementById('command-input').blur(); true`);
        const btn = await ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(rowSel('alpha') + ' button')})].find(b => b.getBoundingClientRect().width > 0); if (!b) return null; b.setAttribute('data-t', '1'); return true; })()`);
        if (btn) {
            await ev(`document.querySelector(${JSON.stringify(rowSel('alpha'))}).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`);
            await clickAt(rowSel('alpha') + ' button[data-t]');
            await sleep(500); // sleep-ok: a handler that wrongly focuses the box does it within frames; there is no completion event
            assert.notEqual(await active(), 'command-input', 'a click on a row button leaves the cursor out of the message box');
        }
        // 3. the Agents tab brings the selected agent back with the cursor in its box
        await ev(`window.switchNavTab('tokens'); true`);
        await waitFor(`document.body.getAttribute('data-nav-tab') === 'tokens'`, 'on Analytics');
        await clickAt('#nav-tab-agents');
        await waitFor(`document.getElementById('live-session-view') && document.getElementById('live-session-view').getClientRects().length > 0`, 'the agent shows again');
        await waitFor(`document.activeElement && document.activeElement.id === 'command-input'`, 'the Agents tab puts the cursor in the message box: ' + await active(), 5000);
        console.log('PASS 1440: a click on a row or on the Agents tab puts the cursor in the message box; a row button does not');

        // 4. a phone: no keyboard pop-up
        await setup(390, 844, true);
        await ev(`window.switchNavTab('agents'); true`);
        await sleep(300); // sleep-ok: the phone's list draws over frames
        await ev(`document.activeElement && document.activeElement.blur(); true`);
        const p = await ev(`!!document.querySelector('[data-action="session-open"], [data-on-click="session-open"]')`);
        await ev(`(() => { const e = document.querySelector('[data-on-click="session-open"], [data-action="session-open"]'); if (e) e.click(); return true; })()`);
        await sleep(800); // sleep-ok: a handler that wrongly focuses the box does it within frames; there is no completion event
        assert.notEqual(await active(), 'command-input', 'a phone is not given the keyboard (' + p + ')');
        console.log('PASS 390: opening an agent does not focus the message box');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
