// A phone's agent page is ONE row at the top (#11056, the operator: "the hamburger menu and the agent toolbar should be one line and take up a single row"): under 640 px, while an agent is open, the page's top bar is hidden and its menu button is the
// first of the agent's header: ☰, ←, the dot and the name (the team under it), the Chat/Terminal switch, ⋯. The chat starts right under that row. Search, the panel and the Details (folder, model) are behind ⋯. At 390 px, at 100% and 200% text:
// one row of 44 px controls, nothing overlapping or off the screen; each control works; at 1280 the page is as it was. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a layout settles over frames; there is no completion event (used once, below)
    const open = async (w, fs, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__m.add('orchestrator', 'A', 12, { sleeping: false, session_id: 'o-id', board_project: 'coral-hub' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'orchestrator')`, 'the agent', 10000);
        await ev(`window.selectLiveSession('orchestrator', 'claude', 'o-id', 'local'); true`);
        await waitFor(`document.getElementById('terminal-header-label')?.textContent === 'orchestrator' && document.querySelector('.terminal-header').getClientRects().length > 0`, `${w}@${fs}: the agent's header`, 10000);
        await waitFor(`document.querySelector('#live-session-view .terminal-header').getBoundingClientRect().height > 30`, `${w}@${fs}: the row has its height`, 4000);
        await sleep(400); // sleep-ok: the row settles over frames after the first draw
    };
    const rects = () => ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header'), r = h.getBoundingClientRect(); const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 1;
        const box = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
        const names = ['agent-bar-menu', 'terminal-status-dot', 'terminal-header-identity', 'live-view-btn-chat', 'live-view-btn-terminal', 'agent-bar-more'], parts = names.map(n => [n, document.getElementById(n)]).concat([['back', h.querySelector('.terminal-back-btn')]]);
        const shown = parts.filter(([, e]) => e && vis(e)).map(([n, e]) => [n, box(e)]);
        const more = ['chat-find-btn', 'popout-panel-toggle-btn'].map(n => [n, document.getElementById(n)]).filter(([, e]) => e && vis(e)).map(([n, e]) => [n, box(e)]);
        const top = document.querySelector('header.top-bar');
        return { header: box(h), shown, more, topBar: top ? getComputedStyle(top).display : 'none', sideways: document.documentElement.scrollWidth - innerWidth, detailsOpen: document.getElementById('agent-phone-details').open, detailsH: Math.round(document.getElementById('agent-phone-details').getBoundingClientRect().height),
            under: (() => { const e = document.elementFromPoint(195, Math.min(innerHeight - 5, r.bottom + 10)); return e ? { tag: e.tagName, inHeader: !!e.closest('.terminal-header'), inDetails: !!e.closest('#agent-phone-details'), inView: !!e.closest('#live-session-view') } : null; })() }; })()`);
    const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const fs of [16, 32]) {
            await open(390, fs, true);
            let m = await rects();
            assert.equal(m.topBar, 'none', `${fs}: the page's top bar is hidden while an agent is open`);
            const names = m.shown.map(s => s[0]);
            for (const n of ['agent-bar-menu', 'back', 'terminal-header-identity', 'live-view-btn-chat', 'live-view-btn-terminal', 'agent-bar-more']) assert.ok(names.includes(n), `${fs}: ${n} is in the row: ` + JSON.stringify(m.shown));
            for (const [n, b] of m.shown) if (/menu|back|live-view|more/.test(n)) assert.ok(b.r - b.l >= 43 && b.b - b.t >= 43, `${fs}: ${n} is a 44 px target: ` + JSON.stringify(b));
            if (fs === 16) {
                assert.ok(m.header.b - m.header.t <= 60, `100%: the row is about 56 px: ` + JSON.stringify(m.header));
                const tops = m.shown.filter(s => /menu|back|live-view-btn-chat|more/.test(s[0])).map(s => (s[1].t + s[1].b) / 2);
                assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `100%: one centre line: ` + JSON.stringify(m.shown));
                assert.ok(m.under && m.under.inView && !m.under.inHeader && !m.under.inDetails, `100%: the chat starts right under the row: ` + JSON.stringify(m.under));
                assert.ok(m.detailsH <= 1, `100%: Details is closed under the row: ${m.detailsH}`);
            }
            for (let i = 0; i < m.shown.length; i++) for (let j = i + 1; j < m.shown.length; j++) assert.ok(!overlap(m.shown[i][1], m.shown[j][1]), `${fs}: ${m.shown[i][0]} and ${m.shown[j][0]} do not overlap: ` + JSON.stringify(m.shown));
            assert.ok(m.shown.every(([, b]) => b.l >= 0 && b.r <= 390), `${fs}: everything is inside the screen: ` + JSON.stringify(m.shown));
            assert.ok(m.sideways <= 0, `${fs}: nothing scrolls sideways`);
            const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            await shot(`phone-one-row-${fs}`);
            // ☰ opens the menu
            await ev(`document.getElementById('agent-bar-menu').click(); true`);
            await waitFor(`document.getElementById('agent-bar-menu').getAttribute('aria-expanded') === 'true' && !document.getElementById('nav-more-menu').hidden && document.querySelectorAll('#nav-more-menu .nav-more-item').length > 1`, `${fs}: ☰ opens the menu`, 4000);
            await ev(`document.getElementById('agent-bar-menu').click(); true`);
            await waitFor(`document.getElementById('nav-more-menu').hidden`, `${fs}: ☰ closes it`, 4000);
            // ⋯ opens Search, the panel and the Details under the row
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            await waitFor(`document.getElementById('agent-phone-details').open && document.getElementById('chat-find-btn').getBoundingClientRect().width > 0`, `${fs}: ⋯ opens the line under the row`, 4000);
            m = await rects();
            assert.equal(await ev(`document.getElementById('agent-bar-more').getAttribute('aria-expanded')`), 'true', `${fs}: ⋯ says it is open`);
            assert.deepEqual(m.more.map(s => s[0]).sort(), ['chat-find-btn', 'popout-panel-toggle-btn'], `${fs}: Search and the panel are under the row: ` + JSON.stringify(m.more));
            for (const [n, b] of m.more) assert.ok(b.r - b.l >= 43 && b.b - b.t >= 43 && b.t >= m.header.t + 40 && b.r <= 390, `${fs}: ${n} is a 44 px target on the line under the row: ` + JSON.stringify(b));
            assert.ok(m.detailsOpen && m.detailsH > 10, `${fs}: the Details are open (folder, model): ${m.detailsH}`);
            await shot(`phone-one-row-more-${fs}`);
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            await waitFor(`!document.getElementById('agent-phone-details').open && document.getElementById('chat-find-btn').getBoundingClientRect().width === 0`, `${fs}: ⋯ again puts them away`, 4000);
            m = await rects();
            assert.ok(m.more.length === 0 && !m.detailsOpen, `${fs}: ⋯ again puts them away`);
            console.log(`   390@${fs}: ok`);
        }
        // a computer is as it was
        await open(1280, 16, false);
        const d = await ev(`({ top: getComputedStyle(document.querySelector('header.top-bar')).display, menu: getComputedStyle(document.getElementById('agent-bar-menu')).display, more: getComputedStyle(document.getElementById('agent-bar-more')).display })`);
        assert.deepEqual(d, { top: 'flex', menu: 'none', more: 'none' }, '1280: the top bar is there and the phone row\'s buttons are not');
        console.log('PASS the phone agent page is one row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
