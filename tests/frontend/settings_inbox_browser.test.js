// Settings > Inbox, and the quiet line in Needs you (#12144, the Operator's design v6, slice 2): a group "Inbox" in Settings with a switch for each kind of optional item (all on by default), the included teams
// (all ticked), the time of the daily items (09:00), and a plain line that questions and decisions always reach you (no switch). Turning a kind off and a team off, then Save, sends exactly those values; what is saved
// is shown again on the next open. In the Needs you folder a switched-off kind is never silent: one quiet line says what was muted and opens the folder it is in. At 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { window.__puts = []; const real = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
                const hex = c => c.repeat(64), at = i => new Date(Date.now() - i * 3600000).toISOString();
                const file = (c, name, extra) => ({ id: hex(c), name, uri: 'coral://artifacts/' + hex(c), digest: hex(c), available: true, tags: ['for review'], created_at: at(3), ...extra });
                window.__files = [file('a', 'plan.md'), file('b', 'release-notes.md', { kind: 'release', muted: true }), file('d', 'decisions.md', { kind: 'decided', muted: true })];
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href), m = (o.method || 'GET').toUpperCase();
                    if (url.pathname === '/api/settings' && m === 'PUT') { window.__puts.push(JSON.parse(o.body)); return json({ ok: true }); }
                    if (url.pathname === '/api/board/projects') return json([{ project: 'alpha' }, { project: 'beta' }, { project: 'gamma' }]);
                    if (/^\\/api\\/board\\/[a-z]+\\/artifacts$/.test(url.pathname) && url.searchParams.get('tag') === 'for review') return json({ artifacts: url.pathname.includes('/alpha/') ? window.__files : [], has_more: false });
                    return real(u, o); }; return true; })()`);
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = {}; return true; })`);
            await ev(`(async () => { await window.showSettingsModal(); return true; })()`);
            await waitFor(`!!document.getElementById('settings-inbox-release')`, 'the Inbox controls', 8000);
            await sleep(500); // sleep-ok: the team boxes are drawn from the boards the page just read; no event marks them done
            const view = () => ev(`(() => { const on = id => { const e = document.getElementById(id); return e ? e.checked : null; };
                const tab = document.getElementById('settings-tab-needs-you'), pane = document.getElementById('settings-pane-needs-you');
                return { tab: tab ? tab.textContent.replace(/\\s+/g, ' ').trim() : null, always: (document.getElementById('settings-inbox-always') || {}).textContent || '',
                    kinds: ['file', 'done', 'release', 'decided', 'digest'].map(k => on('settings-inbox-' + k)), time: (document.getElementById('settings-inbox-digest-time') || {}).value,
                    teams: [...document.querySelectorAll('#settings-inbox-teams input[data-team]')].map(b => [b.dataset.team, b.checked]), muted: (document.getElementById('settings-inbox-muted') || {}).textContent || '', paneIn: !!pane }; })()`);
            let v = await view();
            check(`${tag}: Settings has an Inbox group`, v.paneIn && /Inbox/.test(v.tab || ''), JSON.stringify(v.tab));
            check(`${tag}: questions and decisions are said to always reach you, with no switch of their own`, /always reach you/i.test(v.always) && !(await ev(`!!document.querySelector('#settings-pane-needs-you input[id*="question"], #settings-pane-needs-you input[id*="decision-always"]')`)), v.always);
            check(`${tag}: every kind is on by default`, JSON.stringify(v.kinds) === '[true,true,true,true,true]', JSON.stringify(v.kinds));
            check(`${tag}: all three teams are ticked, and the daily time is 09:00`, JSON.stringify(v.teams) === '[["alpha",true],["beta",true],["gamma",true]]' && v.time === '09:00', JSON.stringify([v.teams, v.time]));
            // turn Release summaries off and untick gamma, set the time, Save
            await ev(`(() => { const set = (id, f) => { const e = document.getElementById(id); f(e); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
                set('settings-inbox-release', e => { e.checked = false; }); set('settings-inbox-digest-time', e => { e.value = '07:30'; });
                const g = document.querySelector('#settings-inbox-teams input[data-team="gamma"]'); g.checked = false; g.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await ev(`(async () => { await window.applySettings(); return true; })()`);
            await sleep(600); // sleep-ok: the save is stubbed and answers at once; the toast and redraw follow
            const put = await ev(`window.__puts[window.__puts.length - 1] || null`);
            check(`${tag}: Save sends the switch, the teams and the time as chosen`, put && put.inbox_kind_release === false && put.inbox_kind_file === true && put.inbox_digest_time === '07:30' && put.inbox_included_teams === '["alpha","beta"]', JSON.stringify(put && Object.fromEntries(Object.entries(put).filter(([k]) => k.startsWith('inbox_')))));
            await ev(`window.__puts.length = 0; true`);

            // the Needs you folder: the quiet line for what the switches keep out
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); true`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'inbox_reviews.js').then(m => m.refreshReviews(true)).then(() => true)`);
            await waitFor(`!!document.querySelector('.inbox-muted-line')`, 'the quiet Muted line', 8000);
            const line = await ev(`(() => { const p = document.querySelector('.inbox-muted-line'); return { text: p.textContent.replace(/\\s+/g, ' ').trim(), btn: !!p.querySelector('button') }; })()`);
            check(`${tag}: a switched-off kind is never silent: one quiet line says what was muted`, /^Muted by your settings: 1 release summary, 1 decision made for you\. Show them$/.test(line.text) && line.btn, JSON.stringify(line));
            const count = await ev(`import(${S} + 'inbox_reviews.js').then(m => ({ unread: m.unreadReviewItems().length, muted: m.mutedReviewItems().length }))`);
            check(`${tag}: the muted files are not counted, and are kept`, count.unread === 1 && count.muted === 2, JSON.stringify(count));
            await ev(`document.querySelector('.inbox-muted-line button').click(); true`);
            await sleep(400); // sleep-ok: the folder switch redraws over a frame or two
            check(`${tag}: Show them opens the folder they are in (Artifacts)`, await ev(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"][aria-current="true"]')`));
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Settings > Inbox checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
