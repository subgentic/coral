// The Inbox strip's red count pill is whole at 200% text (#11239, the Mobile Beta Tester's re-check of slice A: the digit in the "Needs you" tab's pill was cut in half because the pill's line was a fixed 16 px). At 390 and 320 px, 100%
// and 200% text, light and dark: the pill's text line is at least as tall as its text and nothing in it is clipped. Drives Chrome over CDP through agent_view_harness.js against an isolated dev server, the Inbox's census world.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, fs, theme] of [[390, 16, 'light'], [390, 32, 'light'], [390, 32, 'dark'], [320, 32, 'light']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(INBOX_WORLD);
            await ev(`window.__m.add('Ada', 'A', 2, { sleeping: false, session_id: 'Ada-id' }); true`); // an agent that waits on the person: the Needs you count is the red pill
            await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'), r = await import((window.__coralStatic || '/static/') + 'render.js'); for (const x of s.state.liveSessions) { x.waiting_for_input = true; x.waiting_kind = 'question'; x.waiting_since = new Date().toISOString(); } r.renderLiveSessions(s.state.liveSessions); return true; })()`);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; document.documentElement.setAttribute('data-theme', '${theme}'); localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            const tag = `${w}@${fs} ${theme}`;
            await waitFor(`[...document.querySelectorAll('#group-table-view .view-list-nav .view-list-count')].some(c => c.getClientRects().length && Number(c.textContent) > 0)`, `${tag}: a count in the strip`, 12000);
            const r = await ev(`[...document.querySelectorAll('#group-table-view .view-list-nav .view-list-count')].filter(c => c.getClientRects().length && Number(c.textContent) > 0).map(c => { const cs = getComputedStyle(c), b = c.getBoundingClientRect(), t = c.closest('.view-list-item').getBoundingClientRect(); return { text: c.textContent, alert: c.classList.contains('view-list-alert'), lineH: Math.round(parseFloat(cs.lineHeight) || b.height), fontPx: Math.round(parseFloat(cs.fontSize)), h: Math.round(b.height), clipped: c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1, inTab: b.top >= t.top - 0.5 && b.bottom <= t.bottom + 0.5 }; })`);
            assert.ok(r.some(x => x.alert), `${tag}: a red alert pill is in the strip to check: ` + JSON.stringify(r));
            assert.ok(r.length >= 1 && r.every(x => !x.clipped && x.inTab && x.h >= x.fontPx), `${tag}: a tab's count pill is whole: its line is as tall as its text, nothing clipped: ` + JSON.stringify(r));
        }
        console.log('PASS the strip count pill is whole at 200% text');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
