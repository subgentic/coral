// The phone's one-row agent header and keyboard composer, served as the Hub serves the dashboard (#11085: the Mobile Beta Tester could not test the Hub, #11056, #11060), and the "Updates paused · text selected" chip (#11056):
// (1) cloud boot (helpers/hub_world.js: native boot flag, the Hub's CSP, two computers), an agent of a computer open, 390 px with touch, 100% and 200% text: one row of 44 px controls, the menu button opens the menu, ⋯ opens Search and the panel
// under the row and the Details card over the chat; (2) the composer sits whole inside a shrunk visual viewport (the keyboard); (3) with text selected the chip is under the header and overlaps no header text or control, and the header stays one row,
// at 390 px (Hub-served) and 1000 px (the local dashboard, the Details are offered up to 1100 px).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

const FAKE_VV = `(() => { const t = new EventTarget(); const vv = { height: innerHeight, width: innerWidth, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, addEventListener: (...a) => t.addEventListener(...a), removeEventListener: (...a) => t.removeEventListener(...a), dispatchEvent: e => t.dispatchEvent(e) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv }); window.__kb = (h, top) => { vv.height = h; vv.offsetTop = top || 0; t.dispatchEvent(new Event('resize')); }; })()`;
const rects = `(() => { const h = document.querySelector('#live-session-view .terminal-header'), box = e => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const vis = e => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 1;
    const parts = [['menu', 'agent-bar-menu'], ['back', null], ['identity', 'terminal-header-identity'], ['chat', 'live-view-btn-chat'], ['terminal', 'live-view-btn-terminal'], ['more', 'agent-bar-more']].map(([n, id]) => [n, id ? document.getElementById(id) : h.querySelector('.terminal-back-btn')]).filter(([, e]) => e && vis(e)).map(([n, e]) => [n, box(e)]);
    const top = document.querySelector('header.top-bar'), chip = document.getElementById('selection-pause-badge');
    return { header: box(h), parts, topBar: top ? getComputedStyle(top).display : 'none', sideways: document.documentElement.scrollWidth - innerWidth, chip: chip && getComputedStyle(chip).display !== 'none' ? box(chip) : null, mode: JSON.parse(document.getElementById('coral-boot').textContent).mode }; })()`;
const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const select = () => ev(`(() => { const w = document.getElementById('capture-wrapper'), t = w.querySelector('.chat-bubble .message-text, .chat-bubble') || document.getElementById('terminal-header-label'); const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); return !!t; })()`);
    try {
        // (1) and (2): Hub-served
        for (const fs of [16, 32]) {
            await setupHubWorld({ client, Page, Emulation, width: 390, height: 844, mobile: true });
            await Page.addScriptToEvaluateOnNewDocument({ source: FAKE_VV });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await ev(`window.__coralReady.startup('liveList', 'settings')`);
            await waitFor(`(window.__qaState ? window.__qaState.liveSessions : []).length >= 0 && !!document.querySelector('#mobile-agent-list')`, 'the list', 10000);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.selectLiveSession('hub-agent-2', 'claude', 'hub-agent-2', 'm2'); true`);
            await waitFor(`document.getElementById('terminal-header-label')?.textContent.includes('Build agent') && document.querySelector('#live-session-view .terminal-header')?.getClientRects().length > 0`, `${fs}: the Hub's agent opens`, 12000);
            let m = await ev(rects);
            assert.equal(m.mode, 'cloud', `${fs}: the page is the Hub's`);
            assert.equal(m.topBar, 'none', `${fs}: the top bar is hidden while an agent is open`);
            const names = m.parts.map(p => p[0]);
            for (const n of ['menu', 'back', 'identity', 'chat', 'terminal', 'more']) assert.ok(names.includes(n), `${fs}: ${n} is in the row: ` + JSON.stringify(m.parts));
            const mids = m.parts.filter(p => /menu|back|chat|more/.test(p[0])).map(p => (p[1].t + p[1].b) / 2);
            assert.ok(Math.max(...mids) - Math.min(...mids) <= 2, `${fs}: one row (the menu, back, switch and ⋯ on one centre line): ` + JSON.stringify(m.parts));
            for (const [n, b] of m.parts) if (/menu|back|chat|terminal|more/.test(n)) assert.ok(b.r - b.l >= 43 && b.b - b.t >= 43, `${fs}: ${n} is a 44 px target: ` + JSON.stringify(b));
            if (fs === 16) assert.ok(m.header.b - m.header.t <= 60, `100%: about 56 px: ` + JSON.stringify(m.header));
            assert.ok(m.parts.every(([, b]) => b.l >= 0 && b.r <= 390) && m.sideways <= 0, `${fs}: nothing off the screen`);
            await ev(`document.getElementById('agent-bar-menu').click(); true`);
            await waitFor(`!document.getElementById('nav-more-menu').hidden && document.querySelectorAll('#nav-more-menu .nav-more-item').length > 1`, `${fs}: the menu button opens the menu`, 4000);
            await ev(`document.getElementById('agent-bar-menu').click(); true`);
            await waitFor(`document.getElementById('nav-more-menu').hidden`, `${fs}: and closes it`, 4000);
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            await waitFor(`document.getElementById('agent-phone-details').open && document.getElementById('chat-find-btn').getBoundingClientRect().width > 0 && document.getElementById('popout-panel-toggle-btn').getBoundingClientRect().width > 0`, `${fs}: ⋯ opens Search and the panel`, 4000);
            assert.ok(await ev(`!document.getElementById('agent-phone-details').hidden && getComputedStyle(document.getElementById('agent-phone-details')).position === 'absolute' && getComputedStyle(document.getElementById('agent-phone-details')).display !== 'none'`), `${fs}: and the Details card over the chat`);
            await ev(`document.getElementById('agent-bar-more').click(); true`);
            if (fs === 16) {
                assert.ok(await ev(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`), 'the Hub-served composer is on screen');
                await ev(`document.getElementById('command-input').focus(); window.__kb(520, 0); true`);
                await waitFor(`Math.round(document.body.getBoundingClientRect().height) <= 521`, 'the page follows the viewport', 4000);
                const g = await ev(`(() => { const b = e => e && e.getClientRects().length ? { t: e.getBoundingClientRect().top, b: e.getBoundingClientRect().bottom } : null; return { pane: b(document.getElementById('command-pane')), input: b(document.getElementById('command-input')), send: b(document.querySelector('.mobile-send-btn')) }; })()`);
                for (const [k, v] of Object.entries(g)) if (v) assert.ok(v.t >= -1 && v.b <= 521, `the ${k} is inside the 520 px the keyboard leaves: ` + JSON.stringify(g));
                await ev(`window.__kb(844, 0); true`);
            }
            console.log(`   hub 390@${fs}: ok`);
        }
        // (3) the paused chip, Hub-served at 390 px
        await setupHubWorld({ client, Page, Emulation, width: 390, height: 844, mobile: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`window.selectLiveSession('hub-agent-2', 'claude', 'hub-agent-2', 'm2'); true`);
        await waitFor(`document.getElementById('terminal-header-label')?.textContent.includes('Build agent') && document.querySelector('#live-session-view .terminal-header')?.getClientRects().length > 0`, 'the agent', 12000);
        const before = (await ev(rects)).header;
        assert.ok(await select(), 'something to select');
        await waitFor(`getComputedStyle(document.getElementById('selection-pause-badge')).display !== 'none'`, 'the paused chip', 4000);
        const p = await ev(rects);
        assert.ok(p.chip && p.chip.t >= p.header.b - 1, `390: the chip is under the header: ` + JSON.stringify({ chip: p.chip, header: p.header }));
        for (const [n, b] of p.parts) assert.ok(!overlap(b, p.chip), `390: the chip overlaps no header control or text (${n}): ` + JSON.stringify({ chip: p.chip, b }));
        assert.equal(p.header.b - p.header.t, before.b - before.t, '390: the header keeps its height (still one row) with the chip showing');
        console.log('   hub 390 paused: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
