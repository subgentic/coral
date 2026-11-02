// A name clicked inside the question dialog with a reply typed (#12299, QA2's INFO on #12168): "Leave this dialog?" must be ANSWERABLE. The question dialog is a native modal dialog, which sits in the top layer above everything
// else; the confirm is a plain modal, so it can be shown and still be unreachable (the dialog is on top of it and the page behind the dialog is inert). Real mouse events through the protocol, and the check that the confirm's
// Open chat button is what is at its own centre. With no words typed the click opens the chat at once, with no question. 1280 and 390 px; the question route is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const S = `(window.__coralStatic || '/static/')`;
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the confirm is drawn a frame or two after the click
    const clickAt = async sel => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); assert.ok(r, 'there is ' + sel);
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
    const openDialog = async (at) => {
        await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
        await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog[open] .agent-link')`, at + 'the question dialog with its asker as a link', 5000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await ev(`localStorage.clear(); sessionStorage.clear(); true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => { const st = await import(${S} + 'state.js'); st.state.liveSessions = [{ session_id: 'sess-orch', name: 'orch-agent', agent_type: 'claude', board_subscriber_id: 'Orchestrator', board_project: 'coral-hub' }]; window.__opened = null; window.selectLiveSession = (...a) => { window.__opened = a; };
                const asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: '@Operator which way?', at: new Date().toISOString() }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Orchestrator"]')`, at + 'the question row', 10000);
            const where = await ev(`location.pathname`);
            // the confirm is found by what a person reads: the visible words "Leave this dialog?" and the buttons named Open chat and Cancel in the same box, however it is built
    const FIND = `const box = [...document.querySelectorAll('h1, h2, h3, .modal-title, [id$=title]')].find(h => /Leave this dialog\\?/.test(h.textContent) && h.getClientRects().length); const root = box && (box.closest('dialog, .modal, [role=dialog]') || box.parentElement); const btn = t => root && [...root.querySelectorAll('button')].find(b => b.textContent.trim() === t && b.getClientRects().length);`;
    const confirm = () => ev(`(() => { ${FIND} const y = btn('Open chat'); if (!y) return { shown: false }; const b = y.getBoundingClientRect(), el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { shown: true, reachable: !!el && (el === y || y.contains(el)), label: y.textContent.trim() }; })()`);
    const clickConfirm = async label => { const r = await ev(`(() => { ${FIND} const y = btn(${JSON.stringify(label)}); if (!y) return null; const b = y.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`); assert.ok(r, 'the confirm has a ' + label + ' button');
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }); };

            // words typed: the click asks first, the question is answerable, Cancel keeps the words, Open chat opens the chat
            await openDialog(at);
            await ev(`(() => { const t = document.querySelector('dialog.inbox-ask-dialog textarea'); t.focus(); t.value = 'half a reply'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await clickAt('dialog.inbox-ask-dialog .agent-link'); await settle(500);
            const c = await confirm();
            assert.ok(c.shown && c.label === 'Open chat', at + 'with words typed, "Leave this dialog?" is asked: ' + JSON.stringify(c));
            if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/leave-confirm-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } // CORAL_SCREENSHOT_DIR: a picture of the confirm over the question dialog (for review)
            assert.ok(c.reachable, at + 'and it can be answered: its Open chat button is what is at its own centre, not the question dialog above it: ' + JSON.stringify(c));
            assert.equal(await ev(`!!window.__opened`), false, at + 'nothing opened yet');
            // Escape on the confirm closes the confirm only: the question dialog and its words stay
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); await settle(400);
            assert.ok(!(await confirm()).shown && await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]') && document.querySelector('dialog.inbox-ask-dialog textarea').value === 'half a reply'`), at + 'Escape closes the confirm only: the question dialog and its words stay');
            await clickAt('dialog.inbox-ask-dialog .agent-link'); await settle(500);
            assert.ok((await confirm()).shown, at + 'asked again after Escape');
            await clickConfirm('Cancel'); await settle(400);
            assert.ok(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]') && document.querySelector('dialog.inbox-ask-dialog textarea').value === 'half a reply'`), at + 'Cancel keeps the dialog and the words');
            await clickAt('dialog.inbox-ask-dialog .agent-link'); await settle(500);
            await clickConfirm('Open chat'); await settle(500);
            assert.ok(await ev(`!!window.__opened`) && !(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`)), at + 'Open chat: the chat opens and the dialog closes');
            assert.notEqual(await ev(`location.pathname`), where, at + 'the page moved to the chat');

            // nothing typed: no question
            await ev(`window.__opened = null; window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('button[aria-label="Answer the question of Orchestrator"]')`, at + 'the row again', 10000);
            await openDialog(at);
            await clickAt('dialog.inbox-ask-dialog .agent-link'); await settle(500);
            assert.ok(await ev(`!!window.__opened`) && !(await confirm()).shown, at + 'with nothing typed the click opens the chat with no question');
        }
    } finally { await client.close(); }
    console.log('ask_leave_dialog_browser: ok');
})().catch(e => { console.error(e && e.message || e); process.exit(1); });
