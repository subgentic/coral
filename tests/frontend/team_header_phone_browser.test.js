// The team page header on a phone (#12534, the new-user walk #12526 at 390 and 430): the status line '2 of 3 waiting for first signal. A signal is an agent's first message.' is whole (it wraps; it was cut with an
// ellipsis), and the tab strip does not start with a half-hidden tab ('ents 3' for 'Agents 3') when the Agents tab is the open one. The team's status is stubbed with three agents, two of them with no signal yet.
// Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-hdr-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h] of [[320, 844], [390, 844]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const R = window.fetch.bind(window); const j = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                    if (/\\/api\\/board\\/[^/]+\\/status$/.test(url.pathname)) return j({ summary: {}, observed_at: new Date().toISOString(), agents: ['Orchestrator', 'Backend Dev', 'QA Engineer'].map((n, i) => ({ name: n, subscriber_id: n, session_id: 'sid-' + (i + 1), availability: i === 0 ? 'available' : 'unknown' })) });
                    return R(u, o); }; return true; })()`);
            await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`window.switchNavTab('agents'); window.openTeamPage(${JSON.stringify(TEAM)}, { tab: 'agents' }); true`);
            await waitFor(`(document.getElementById('team-page-title') || {}).textContent === ${JSON.stringify(TEAM)}`, 'the team page opened on its Agents tab', 10000); await settle(1500);
            const originalStatus = await ev(`document.getElementById('team-page-status').textContent`);
            for (const theme of ['dark', 'light']) for (const size of [16, 32]) {
                await ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.style.fontSize = '${size}px'; true`);
                await settle(100);
                await ev(`document.getElementById('team-page-status').textContent = 'Checking attention status'; true`);
                const title = await ev(`(() => { const e = document.getElementById('team-page-title'), r = e.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(e); const t = range.getBoundingClientRect(); return { box: { top: r.top, bottom: r.bottom, height: r.height }, text: { top: t.top, bottom: t.bottom, height: t.height }, head: document.getElementById('team-page-head').getBoundingClientRect().toJSON(), line: getComputedStyle(e).lineHeight, textOverflow: getComputedStyle(e).textOverflow }; })()`);
                await shot(`team-title-${w}-${theme}-${size}`);

                assert.ok(title.text.top >= title.head.top && title.text.bottom <= title.head.bottom && title.text.top >= title.box.top && title.text.bottom <= title.box.bottom, 'the title glyphs fit vertically: ' + JSON.stringify(title));
                assert.equal(title.textOverflow, 'ellipsis', 'long titles retain an ellipsis');
            }
            await ev(`document.documentElement.style.fontSize = ''; document.getElementById('team-page-status').textContent = ${JSON.stringify(originalStatus)}; true`);
            const at = `${w}: `;
            const st = await ev(`(() => { const e = document.getElementById('team-page-status'); return { text: e.textContent.trim(), cutX: e.scrollWidth > e.clientWidth + 1, cutY: e.scrollHeight > e.clientHeight + 1, ellipsis: getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).whiteSpace === 'nowrap' }; })()`);
            await shot(`team-header-${w}`);
            assert.match(st.text, /2 of 3 agents have not sent a first message yet/, at + 'the status says it: ' + JSON.stringify(st));
            assert.ok(!st.cutX && !st.cutY && !st.ellipsis, at + 'the whole line is shown, not cut: ' + JSON.stringify(st));
            const clipped = () => ev(`(() => { const s = document.getElementById('team-tabs'), sr = s.getBoundingClientRect(); return { scrollLeft: Math.round(s.scrollLeft), clipped: [...s.querySelectorAll('[role=tab]')].filter(t => t.getClientRects().length).map(t => { const r = t.getBoundingClientRect(); return { name: t.textContent.trim(), left: r.left < sr.left - 1 && r.right > sr.left + 1 }; }).filter(t => t.left).map(t => t.name) }; })()`);
            for (const tab of ['agents', 'tasks', 'artifacts', 'agents']) {
                await ev(`document.getElementById('team-tab-${tab}') && document.getElementById('team-tab-${tab}').click(); true`); await settle(700);
                const t = await clipped();
                assert.deepEqual(t.clipped, [], at + `with ${tab} open no tab starts half-hidden at the strip's left edge: ` + JSON.stringify(t));
            }
        }
    } finally { await removeBoards?.(ev, [TEAM]).catch?.(() => {}); await client.close(); }
    console.log('PASS the team header line is whole and the tab strip starts clean on a phone');
})().catch(e => { console.error(e); process.exit(1); });
