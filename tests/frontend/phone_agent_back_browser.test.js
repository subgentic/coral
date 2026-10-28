// The phone's agent page (#9999, #9961 point 5, the beta tester: "no back arrow or agent list, the title bar still says Agents, the right-panel button is an unlabeled icon"): the agent's header has a back arrow
// at the left, a 44 px target named Agents, that returns to the agent list; the panel button says what it opens (files, tasks and notes), in its name and its tooltip. 390 px with touch. A desktop has neither the arrow nor a change.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { settle } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.__m.add('back-bot', 'A', 3, { sleeping: false }); true`); await settle(ev, 600); // sleep-ok: the first live list renders from several answers
        await ev(`window.selectLiveSession('back-bot', 'claude', 'back-bot-id', 'local'); true`);
        await waitFor(`document.getElementById('live-session-view') && getComputedStyle(document.getElementById('live-session-view')).display !== 'none'`, 'the agent page', 8000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await open(390, true);
        const b = await ev(`(() => { const e = document.querySelector('.terminal-header .terminal-back-btn'); if (!e) return null; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return { name: e.getAttribute('aria-label'), title: e.title, w: Math.round(r.width), h: Math.round(r.height), shown: c.display !== 'none' && r.width > 0, left: Math.round(r.left) }; })()`);
        assert.ok(b && b.shown && b.w >= 44 && b.h >= 44 && b.name === 'Agents' && b.left <= 24, 'the agent header has a back arrow, a 44 px target named Agents, at its left edge: ' + JSON.stringify(b));
        const p = await ev(`(() => { const e = document.querySelector('.terminal-header #popout-panel-toggle-btn'); if (!e) return null; const r = e.getBoundingClientRect(); return { name: e.getAttribute('aria-label'), title: e.title, shown: r.width > 0 }; })()`);
        assert.ok(p && p.shown && /files, tasks and notes/i.test(p.name) && /files, tasks and notes/i.test(p.title), 'the panel button says what it opens: ' + JSON.stringify(p));
        await shot('phone-agent-back-390');
        await ev(`document.querySelector('.terminal-header .terminal-back-btn').click(); true`);
        await waitFor(`getComputedStyle(document.getElementById('live-session-view')).display === 'none' && document.querySelector('#mobile-agent-list, #mobile-session-list') && document.querySelector('#mobile-agent-list, #mobile-session-list').getClientRects().length > 0`, 'the back arrow returns to the agent list', 6000);
        await open(1280, false);
        assert.equal(await ev(`(() => { const e = document.querySelector('.terminal-header .terminal-back-btn'); return !e || getComputedStyle(e).display === 'none'; })()`), true, 'a desktop has no back arrow');
        console.log('PASS the phone agent page has a way back and a named panel button');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
