// The Board's one-line message rows by keyboard alone (#9783, the v2.0.2 keyboard pass; #7921, #9650): Tab lands on a row's toggle, Enter opens the message in place and keeps focus on the toggle (aria-expanded true), the open message's actions (Reply, Copy link, More)
// are the next Tab stops, before the next row's, a second Enter closes it, and the toggle's name (the one Chrome computes) holds the sender and the start of the message. Real board over the API; 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'kbr-' + Date.now().toString(36);
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'] };
    const key = async (k, shift) => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : undefined; const mods = shift ? 8 : 0; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: mods }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods }); await new Promise(r => setTimeout(r, 120)); }; // sleep-ok: the key's handlers run
    const active = () => ev(`(() => { const e = document.activeElement; return e ? { cls: String(e.className || ''), text: (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), exp: e.getAttribute('aria-expanded'), inRow: e.closest('#mb-messages > .mb-message') ? [...document.querySelectorAll('#mb-messages > .mb-message')].indexOf(e.closest('#mb-messages > .mb-message')) : -1 } : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const id of ['Orchestrator', 'QA Engineer', 'Backend Dev']) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: id, session_name: id + '-s' })).status, 200);
        for (const [who, text] of [['QA Engineer', 'Review of the Inbox patch: approved with two small follow-ups. @Orchestrator #7740'], ['Backend Dev', 'Agreed, the count already follows the read. #7757'], ['Orchestrator', 'Fine. Please look at the plan when you can. #7809']]) assert.equal((await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content: text })).status, 200);
        for (const [tag, w, mobile] of [['1280', 1280, false], ['390', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`try { localStorage.setItem('coral.board.view', 'table'); } catch {} true`);
            await Page.navigate({ url: BASE + `/team/${B}/messages` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await waitFor(`document.querySelectorAll('#mb-messages > .mb-message').length >= 3`, `${tag}: the rows`, 15000); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the rows settle
            await ev(`document.querySelectorAll('#mb-messages > .mb-message .mb-row-toggle')[1].setAttribute('data-axp', 'x'); true`);
            const ax = await axName(client, '[data-axp="x"]'); check(ax && ax.role === 'button' && /Backend Dev/.test(ax.name) && /Agreed/.test(ax.name), `${tag}: a row's toggle is a button named by its sender and the start of the message: ${JSON.stringify(ax)}`);
            await ev(`document.querySelectorAll('#mb-messages > .mb-message .mb-row-toggle')[1].focus(); true`);
            await key('Enter'); let a = await active(); check(a && /mb-row-toggle/.test(a.cls) && a.exp === 'true', `${tag}: Enter opens the message and focus stays on its toggle: ${JSON.stringify(a)}`);
            const seen = []; for (let i = 0; i < 6; i++) { await key('Tab'); a = await active(); seen.push(a && (a.inRow + ':' + a.text)); if (a && a.inRow !== 1) break; }
            check(seen.length > 1 && /^1:/.test(seen[0]), `${tag}: the open message's own controls are the next Tab stops, before the next row (${JSON.stringify(seen)})`);
            check(seen.slice(0, -1).some(t => /Reply/i.test(t)), `${tag}: Reply is among them (${JSON.stringify(seen)})`);
            await ev(`document.querySelectorAll('#mb-messages > .mb-message .mb-row-toggle')[1].focus(); true`); await key('Enter'); a = await active();
            check(a && /mb-row-toggle/.test(a.cls) && a.exp === 'false', `${tag}: a second Enter closes it, focus on the toggle: ${JSON.stringify(a)}`);
            console.log(`   ${tag}: done`);
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.deepEqual(found, [], 'the Board rows by keyboard:\n  ' + found.join('\n  '));
    console.log('PASS the Board rows by keyboard');
})().catch(e => { console.error(e); process.exit(1); });
