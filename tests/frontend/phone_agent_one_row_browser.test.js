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
        await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__m.add('orchestrator-with-a-long-name', 'A', 12, { sleeping: false, session_id: 'o-id', board_project: 'a-team-with-a-long-name' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'orchestrator-with-a-long-name')`, 'the agent', 10000);
        await ev(`window.selectLiveSession('orchestrator-with-a-long-name', 'claude', 'o-id', 'local'); true`);
        await waitFor(`document.getElementById('terminal-header-label')?.textContent === 'orchestrator-with-a-long-name' && document.querySelector('.terminal-header').getClientRects().length > 0`, `${w}@${fs}: the agent's header`, 10000);
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
            { // ONE row at both text sizes, a long name and a long team too: no control wraps under another (the Mobile Beta Tester: 91 px, then three rows)
                const tops = m.shown.filter(s => /menu|back|live-view-btn-chat|more/.test(s[0])).map(s => (s[1].t + s[1].b) / 2);
                assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `${fs}: one centre line, the menu, back, switch and ⋯ on one row: ` + JSON.stringify(m.shown));
            }
            if (fs === 16) {
                assert.ok(m.header.b - m.header.t <= 60, `100%: the row is about 56 px: ` + JSON.stringify(m.header));
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
        // a computer: the top bar stays, the header is its one row and Details has no row of its own (the operator, #11056): ⋯ opens the facts as a card over the chat, nothing under it moves, and the paused chip overlaps no header text
        await open(1000, 16, false); // the Details are offered up to 1100 px: wider, the header holds the branch and the folder is the name's tip
        const d = await ev(`({ top: getComputedStyle(document.querySelector('header.top-bar')).display, menu: getComputedStyle(document.getElementById('agent-bar-menu')).display })`);
        assert.deepEqual(d, { top: 'flex', menu: 'none' }, '1000: the top bar is there and the phone row\'s menu button is not');
        const geo = () => ev(`(() => { const h = document.querySelector('#live-session-view .terminal-header').getBoundingClientRect(), p = document.getElementById('pane-capture').getBoundingClientRect(), det = document.getElementById('agent-phone-details'), c = det.getBoundingClientRect(), more = document.getElementById('agent-bar-more'), chip = document.getElementById('selection-pause-badge');
            const cb = chip.getBoundingClientRect(); return { headerBottom: Math.round(h.bottom), headerH: Math.round(h.height), paneTop: Math.round(p.top), detailsPos: getComputedStyle(det).position, detailsShown: getComputedStyle(det).display !== 'none', detailsTop: Math.round(c.top), detailsBottom: Math.round(c.bottom), moreShown: getComputedStyle(more).display !== 'none', chipTop: Math.round(cb.top), chipShown: getComputedStyle(chip).display !== 'none' }; })()`);
        let g = await geo();
        assert.ok(g.moreShown, `1000: ⋯ is in the header while there are details: ` + JSON.stringify(g));
        assert.ok(!g.detailsShown && g.paneTop - g.headerBottom <= 8, `1000: Details has no row: the chat starts within 8 px of the header's bottom: ` + JSON.stringify(g));
        const before = g.paneTop;
        await ev(`document.getElementById('agent-bar-more').click(); true`);
        await waitFor(`document.getElementById('agent-phone-details').open && getComputedStyle(document.getElementById('agent-phone-details')).display !== 'none'`, '1000: ⋯ opens the Details', 4000);
        g = await geo();
        assert.equal(g.detailsPos, 'absolute', '1000: the Details are a card over the chat: ' + JSON.stringify(g));
        assert.ok(g.paneTop === before && Math.abs(g.detailsTop - g.headerBottom) <= 2, `1000: opening them moves nothing under the header: ` + JSON.stringify(g));
        await ev(`document.getElementById('agent-bar-more').click(); true`);
        // a chat with nothing said yet (the Mobile Beta Tester's server): ⋯ still opens the card
        await ev(`window.__m.add('empty-chat', 'E', 0, { sleeping: false, session_id: 'e-id', board_project: 'a-team' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === 'empty-chat')`, '1000: the empty chat agent', 10000);
        await ev(`window.selectLiveSession('empty-chat', 'claude', 'e-id', 'local'); true`);
        await waitFor(`document.getElementById('terminal-header-label')?.textContent === 'empty-chat' && getComputedStyle(document.getElementById('agent-bar-more')).display !== 'none'`, '1000: ⋯ for the empty chat', 10000);
        await ev(`(() => { const m = document.getElementById('agent-bar-more'); if (m.getAttribute('aria-expanded') !== 'true') m.click(); return true; })()`);
        await waitFor(`document.getElementById('agent-phone-details').open && getComputedStyle(document.getElementById('agent-phone-details')).display !== 'none'`, '1000: ⋯ opens the card even in a chat with nothing said yet', 4000);
        // the paused chip: under the header, over none of its text
        for (const [w, mobile] of [[1000, false], [390, true]]) {
            if (w === 390) await open(390, 16, true);
            await ev(`document.getElementById('selection-pause-badge').style.display = ''; true`);
            await waitFor(`document.getElementById('selection-pause-badge').getBoundingClientRect().width > 0`, `${w}: the chip`, 4000);
            g = await geo();
            assert.ok(g.chipShown && g.chipTop >= g.headerBottom - 1, `${w}: the "Updates paused" chip is under the header, not over its text: ` + JSON.stringify(g));
            { // overlaps no header control or text, and the header keeps its height with the chip showing (#11085)
                const chipBox = await ev(`(() => { const b = document.getElementById('selection-pause-badge').getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; })()`);
                const hdrNow = await rects();
                for (const [n, b] of hdrNow.shown) assert.ok(!overlap(b, chipBox), `${w}: the chip overlaps no header part (${n}): ` + JSON.stringify({ chipBox, b }));
                await ev(`document.getElementById('selection-pause-badge').style.display = 'none'; true`);
                const hdrOff = await rects();
                assert.equal(hdrNow.header.b - hdrNow.header.t, hdrOff.header.b - hdrOff.header.t, `${w}: the header keeps its height with the chip showing`);
            }
        }
        console.log('PASS the phone agent page is one row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
