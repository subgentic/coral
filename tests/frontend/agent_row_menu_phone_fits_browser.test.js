// A phone's agent row menu fits the screen and scrolls (walk 63 F3, #17333): at 390 x 844 and 412 x 915 as touch, the menu opened from a row's ... button is no taller than the window,
// sits wholly inside it, scrolls when its items are more than fit, and its last item (Kill session) can be scrolled to and tapped. It was 1000 px tall, fixed at the top, with the end below the screen.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const [w, h] of [[390, 844], [412, 915]]) {
            const at = `${w}x${h}: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/agents' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__m.add('proj1', 'A', 2, { sleeping: false, session_id: 'w-sid', display_name: 'Writer', board_project: 'team-x' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); true`);
            await waitFor(`!!document.querySelector('.session-group-item .sidebar-kebab-btn')`, at + 'the agent row', 10000);
            await ev(`document.querySelector('.session-group-item .sidebar-kebab-btn').click(); true`);
            await waitFor(`[...document.querySelectorAll('.sidebar-kebab-menu')].some(m => getComputedStyle(m).display !== 'none')`, at + 'the menu opens', 4000);
            await ev(`(() => { const m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const more = [...m.querySelectorAll('.menu-item')].find(e => e.textContent.trim() === 'More'); if (more) more.click(); return true; })()`);
            await ev(framesJs(6));
            const r = await ev(`(() => { const m = [...document.querySelectorAll('.sidebar-kebab-menu')].find(x => getComputedStyle(x).display !== 'none'); const b = m.getBoundingClientRect();
                const items = [...m.querySelectorAll('.menu-item')].filter(e => e.getClientRects().length); const last = items[items.length - 1];
                m.scrollTop = m.scrollHeight; const l = last.getBoundingClientRect(), hit = document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
                return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), scrolls: m.scrollHeight > m.clientHeight, overflowY: getComputedStyle(m).overflowY, last: last.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40), lastTop: Math.round(l.top), lastBottom: Math.round(l.bottom), lastHit: !!hit && (hit === last || last.contains(hit)), n: items.length, inner: innerHeight }; })()`);
            if (r.top < 0 || r.bottom > r.inner) problems.push(at + `the menu is wholly inside the window: ${JSON.stringify(r)}`);
            if (!(r.lastTop >= 0 && r.lastBottom <= r.inner && r.lastHit)) problems.push(at + `after scrolling, the last item "${r.last}" is on screen and tappable: ${JSON.stringify(r)}`);
            if (r.height < r.inner * 0.3) problems.push(at + `the menu is not squeezed to nothing: ${JSON.stringify(r)}`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the phone agent row menu:\n  ' + problems.join('\n  '));
    console.log('PASS a phone row menu fits the window and its last item is reachable');
})().catch(e => { console.error(e.message); process.exit(1); });
