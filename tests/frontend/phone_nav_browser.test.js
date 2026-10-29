// The phone's floating nav and + (#11116, slice C), and the card's preview (slice B): at 390 px on the Agents page a pill holds Home, Inbox (the waiting count on it), Tasks and More (the menu, opening above it) and a separate + opens
// New agent and New team; 44 px targets; hidden while the keyboard is up, in an open chat and at 700 px; the list keeps room under both. The preview says "You: ..." for the person's words and "<Name>: ..." for the agent's (last_message), else
// the goal, else "No messages yet"; a row whose last_message is null (an agent's token never gets the person's text) shows the goal. 100% and 200% text, light and dark. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const box = e => `(() => { const b = ${e}.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; })()`;
    const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } };
    const open = async (w, fs, theme) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`for (const n of ['Ada', 'Bo', 'Cy', 'Di']) window.__m.add(n, 'A', 2, { sleeping: false, session_id: n + '-id', board_project: 'team-a' }); true`);
        await waitFor(`(window.__qaState.liveSessions || []).length >= 4`, 'the agents', 10000);
        await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); const lm = { Ada: { role: 'user', text: 'please ship  it\\n today', at: 'x' }, Bo: { role: 'assistant', text: 'Done: the suite passes', at: 'x' }, Cy: null, Di: null };
            for (const r of s.state.liveSessions) { r.last_message = lm[r.name]; if (r.name === 'Di') r.summary = 'Fix the cold start'; if (r.name === 'Ada') r.waiting_for_input = true; if (r.name === 'Bo') r.working = true; } const r = await import((window.__coralStatic || '/static/') + 'render.js'); r.renderLiveSessions(s.state.liveSessions); return true; })()`);
        await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`);
        await waitFor(`document.querySelectorAll('#mobile-session-list .session-group-item').length >= 4 && getComputedStyle(document.getElementById('phone-nav')).display !== 'none'`, `${w}@${fs}: the cards and the nav`, 10000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [fs, theme] of [[16, 'light'], [16, 'dark'], [32, 'light']]) {
            await open(390, fs, theme);
            const tag = `390@${fs} ${theme}`;
            // B: the preview
            const pv = await ev(`Object.fromEntries([...document.querySelectorAll('#mobile-session-list .session-group-item')].map(li => [li.querySelector('.session-label').textContent.trim(), li.querySelector('.session-preview').textContent.trim()]))`);
            assert.deepEqual(pv, { Ada: 'You: please ship it today', Bo: 'Bo: Done: the suite passes', Cy: 'No messages yet', Di: 'Fix the cold start' }, `${tag}: the preview: ` + JSON.stringify(pv));
            // C: the pill and the +
            const items = await ev(`[...document.querySelectorAll('#phone-nav .phone-nav-slot')].map(b => [b.getAttribute('aria-label'), b.getBoundingClientRect().width, b.getBoundingClientRect().height])`);
            assert.deepEqual(items.map(i => i[0]), ['Home, the agents', 'Go to Inbox', 'Go to Tasks', 'More pages'], `${tag}: Home, Inbox, Tasks, More pages`);
            assert.ok(items.every(i => i[1] >= 44 && i[2] >= 44), `${tag}: 44 px targets: ` + JSON.stringify(items));
            const nav = await ev(box(`document.getElementById('phone-nav')`)), fab = await ev(box(`document.getElementById('phone-fab')`));
            assert.ok(nav.b <= 844 - 14 && fab.b <= 844 - 14 && nav.r < fab.l && fab.r <= 390 && nav.h === 64 && fab.w >= 56, `${tag}: the pill and the + float above the bottom, side by side: ` + JSON.stringify({ nav, fab }));
            assert.equal(await ev(`document.querySelector('.phone-nav-slot.active').dataset.phoneNav`), 'nav-agents', `${tag}: Home is the one that is on`);
            // the list keeps room: the last card can scroll above the pill
            const room = await ev(`(() => { const l = document.getElementById('mobile-session-list'), c = getComputedStyle(l); return parseFloat(c.paddingBottom); })()`);
            assert.ok(room >= 96, `${tag}: the list has room under the pill: ${room}`);
            // the slice A lows: one title row with both chips (New is in the + menu), no grey strip, no clipped crescent
            const hdr = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right) }; }, h = document.querySelector('#mobile-agent-list .mobile-list-title'), chips = [...document.querySelectorAll('#mobile-agent-list .phone-chip')].filter(c => !c.hidden), nw = document.querySelector('#mobile-agent-list .mobile-list-header > .btn-small.btn-primary'); return { title: r(h), chips: chips.map(r), n: chips.length, newShown: nw ? getComputedStyle(nw).display !== 'none' : false, display: r(document.querySelector('#mobile-agent-list [data-display-button]')), group: (g => g && g.getClientRects().length ? r(g) : null)(document.querySelector('#mobile-agent-list .group-toggle-btn')) }; })()`);
            assert.equal(hdr.n, 2, `${tag}: both chips show`);
            assert.equal(hdr.newShown, false, `${tag}: New is not in the header (it is in the + menu)`);
            if (fs === 16) assert.ok(hdr.chips.every(c => Math.abs((c.t + c.b) / 2 - (hdr.title.t + hdr.title.b) / 2) <= 6) && hdr.display.t < hdr.title.b + 10 && (!hdr.group || hdr.group.t < hdr.title.b + 10), `${tag}: the title, both chips, the display button and the groups' toggle are one row: ` + JSON.stringify(hdr));
            assert.ok(await ev(`(() => { const l = document.getElementById('mobile-agent-list'); return l.offsetHeight - l.clientHeight === 0 && getComputedStyle(l).overflowX === 'hidden'; })()`), `${tag}: the Agents page draws no horizontal scrollbar (the grey strip under it)`);
            assert.equal(await ev(`[...document.querySelectorAll('#mobile-session-list .session-dot')].map(d => getComputedStyle(d, '::before').content).join()`), 'none,none,none,none', `${tag}: no moon glyph in a card's badge`);
            await new Promise(r => setTimeout(r, 450)); // sleep-ok: the theme's colour transition settles before the picture
            await shot(`phone-nav-${theme}-${fs}`);
            if (fs === 16 && theme === 'light') {
                // the + menu
                await ev(`document.getElementById('phone-fab').click(); true`);
                await waitFor(`!document.getElementById('phone-fab-menu').hidden && document.getElementById('phone-fab').getAttribute('aria-expanded') === 'true'`, 'the + menu', 4000);
                const items2 = await ev(`[...document.querySelectorAll('#phone-fab-menu [role=menuitem]')].map(b => b.textContent.trim())`);
                assert.deepEqual(items2, ['New agent', 'New team'], 'the + menu: New agent, New team');
                const m = await ev(box(`document.getElementById('phone-fab-menu')`));
                assert.ok(m.b <= fab.t && m.r <= 390 && m.l >= 0, `the menu opens above the +: ` + JSON.stringify({ m, fab }));
                await ev(`[...document.querySelectorAll('#phone-fab-menu [role=menuitem]')][1].click(); true`);
                await waitFor(`document.getElementById('phone-fab-menu').hidden && !!document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`, 'New team opens the launch dialog', 6000);
                await ev(`window.hideLaunchModal(); true`);
                // More opens the menu above the pill
                await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-more]').click(); true`);
                await waitFor(`!document.getElementById('nav-more-menu').hidden && document.querySelectorAll('#nav-more-menu .nav-more-item').length > 3`, 'More opens the menu', 4000);
                const mm = await ev(box(`document.getElementById('nav-more-menu')`)), mb = await ev(box(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-more]')`));
                assert.ok(mm.b <= mb.t && mm.t >= 0, `More: the menu is above the button: ` + JSON.stringify({ mm, mb }));
                assert.equal(await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-more]').getAttribute('aria-label')`), 'More pages', 'More keeps its own name');
                await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-more]').click(); true`);
                // Inbox: the page opens, the nav stays, Inbox is the one on, no + there
                await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-inbox]').click(); true`);
                await waitFor(`getComputedStyle(document.getElementById('inbox-view')).display !== 'none' && document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav === 'nav-inbox'`, 'the Inbox', 8000);
                assert.equal(await ev(`getComputedStyle(document.getElementById('phone-nav')).display`), 'flex', 'the nav stays on the Inbox');
                assert.equal(await ev(`getComputedStyle(document.getElementById('phone-fab')).display`), 'none', 'the + is the Agents page\'s');
                await ev(`document.querySelector('.phone-nav-slot[data-phone-nav=nav-agents]').click(); true`);
                await waitFor(`document.querySelector('.phone-nav-slot.active')?.dataset.phoneNav === 'nav-agents' && getComputedStyle(document.getElementById('phone-fab')).display !== 'none'`, 'Home again', 6000);
                // the keyboard hides both
                await ev(`document.body.classList.add('keyboard-open'); true`);
                assert.deepEqual(await ev(`['phone-nav', 'phone-fab'].map(i => getComputedStyle(document.getElementById(i)).display)`), ['none', 'none'], 'with the keyboard up both are gone');
                await ev(`document.body.classList.remove('keyboard-open'); true`);
                // an open chat has neither
                await ev(`window.selectLiveSession('Ada', 'claude', 'Ada-id', 'local'); true`);
                await waitFor(`document.body.classList.contains('live-session-active')`, 'the chat', 8000);
                assert.deepEqual(await ev(`['phone-nav', 'phone-fab'].map(i => getComputedStyle(document.getElementById(i)).display)`), ['none', 'none'], 'in an open chat neither is drawn');
            }
        }
        // desktop is as it was (the Orchestrator's check on slice A): the card parts are in the row at every width and drawn by the phone's styles only
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await waitFor(`getComputedStyle(document.getElementById('phone-nav')).display === 'none' && !!document.querySelector('#live-sessions-list .session-group-item')`, '1280: the sidebar', 8000);
        const d = await ev(`[...document.querySelectorAll('#live-sessions-list .session-group-item')].slice(0, 4).map(li => ({ avatar: getComputedStyle(li.querySelector('.session-avatar')).display, time: getComputedStyle(li.querySelector('.session-time')).display, preview: getComputedStyle(li.querySelector('.session-preview')).display, h: Math.round(li.getBoundingClientRect().height), hidden: li.querySelector('.session-avatar').getAttribute('aria-hidden') + li.querySelector('.session-preview').getAttribute('aria-hidden') }))`);
        assert.ok(d.length >= 3 && d.every(r => r.avatar === 'none' && r.time === 'none' && r.preview === 'none' && r.hidden === 'truetrue'), '1280: the sidebar rows draw no avatar, time or preview (their 36 px height is agent_row_one_line\'s): ' + JSON.stringify(d));
        assert.deepEqual(await ev(`['phone-nav', 'phone-fab'].map(i => getComputedStyle(document.getElementById(i)).display)`), ['none', 'none'], '1280: no floating nav and no +');
        await Emulation.setDeviceMetricsOverride({ width: 700, height: 844, deviceScaleFactor: 1, mobile: true });
        await waitFor(`getComputedStyle(document.getElementById('phone-nav')).display === 'none'`, '700 px: no floating nav', 6000);
        console.log('PASS the phone nav, the + and the preview');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
