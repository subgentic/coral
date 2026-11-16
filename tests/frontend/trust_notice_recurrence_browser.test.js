// #17815: a dismissed request stays dismissed through a transient waiting-state change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`window.__m.add('trust-agent', 'trust', 1, { sleeping: false, session_id: 'trust-one' }); true`);
            await waitFor(`T.state.liveSessions.some(s => s.session_id === 'trust-one')`, 'test agent');
            await ev(`window.switchNavTab('agents'); T.state.settings.notify_needs_input = true; true`);
            const send = async (waiting, since) => ev(`(() => {
                const s = { ...T.state.liveSessions.find(s => s.session_id === 'trust-one'), waiting_for_input: ${waiting}, needs_input: ${waiting}, waiting_kind: ${JSON.stringify(waiting ? 'permission' : '')}, waiting_summary: 'Quick safety check: is this a project you trust?', waiting_since: ${JSON.stringify(since)} };
                T.ws.handleCoralMessage({ type: 'coral_diff', changed: [s] }); return true;
            })()`);
            await send(false, '');
            await send(true, '2026-11-16T02:00:00Z');
            await waitFor(`document.querySelectorAll('.notification-toast').length === 1`, 'first request notice');
            await ev(`document.querySelector('.notification-toast-close').click(); true`);
            await send(false, '');
            await send(true, '2026-11-16T02:00:00Z');
            // A later distinct request proves both asynchronous alert calls have completed.
            await send(false, '');
            await send(true, '2026-11-16T02:01:00Z');
            await waitFor(`document.querySelectorAll('.notification-toast').length >= 1`, 'new waiting episode can notify');
            await ev(framesJs(3));
            const count = await ev(`document.querySelectorAll('.notification-toast').length`);
            if (count !== 1) problems.push(`${width}: expected one new-request toast, got ${count}`);
            if (process.env.CORAL_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/request-notice-${width}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
            }
        }
        assert.deepEqual(problems, [], 'same dismissed request never comes back; a new request still notifies');
        console.log('PASS dismissed request deduplicated by episode; new requests notify at desktop and phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
