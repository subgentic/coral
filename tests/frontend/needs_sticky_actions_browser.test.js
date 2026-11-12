// A phone's Needs you list (#15632, Security's SHOULD on #15540): after a row far down is ticked, the count and bulk actions line stays on screen at the top of the list while the title, search and filters scroll away. 30 review rows stubbed in the page; 390 and 767 px.
// Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'steady-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[390, 844, true], [767, 900, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = Array.from({ length: 30 }, (_, k) => item(k + 1, ['for review'])); window.__needsItems = items;
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`(() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify([{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use for the integration run, and should it be the same one the dashboard is on? Say which, and why.', at: new Date(Date.now() - 300000).toISOString() }]), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3 && !!document.querySelector('${T} tbody tr .inbox-answers, ${T} tbody tr [data-on-click*="ask"], ${T} tbody tr button')`, at + 'the review rows and the question', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);

            const rows = `[...document.querySelectorAll('${T} tbody tr:not(.dt-group)')]`;
            await ev(`(() => { const rs = ${rows}; const tr = rs[rs.length - 1]; tr.scrollIntoView({ block: 'center' }); return true; })()`); await ev(framesJs(3));
            await ev(`(() => { const rs = ${rows}; const c = rs[rs.length - 1].querySelector('.dt-check input, .dt-mail-lead'); c.click(); return true; })()`); await ev(framesJs(4));
            const g = await ev(`(() => { const sc = document.querySelector('${T}'), s = sc.querySelector('.team-tb-selection'), r = s.getBoundingClientRect(), v = sc.getBoundingClientRect(), tr = ${rows}; return { scrolled: Math.round(sc.scrollTop), selTop: Math.round(r.top - v.top), selBottom: Math.round(r.bottom - v.top), viewH: Math.round(v.height), up: sc.querySelector('.list-bar-bar:has(> .tb-low)').style.getPropertyValue('--sel-up'), real: Math.round(r.top - sc.querySelector('.list-bar-bar:has(> .tb-low)').getBoundingClientRect().top), barTop: getComputedStyle(sc.querySelector('.list-bar-bar:has(> .tb-low)')).top, text: s.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60), hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) && s.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), rows: tr.length }; })()`);
            check(g.scrolled > 300, at + 'the list was scrolled far down before the tick: ' + JSON.stringify(g));
            check(g.selTop >= -1 && g.selBottom <= g.viewH, at + 'the actions line is on screen after a row far down is ticked: ' + JSON.stringify(g));
            check(g.selTop <= 8, at + 'the actions line sits at the top of the list: ' + JSON.stringify(g));
            check(/selected/.test(g.text) && g.hit, at + 'it is the actions line, not covered by a row: ' + JSON.stringify(g));
            // #15656: each selection mount replaces the bar's ResizeObserver; the old one is disconnected (one live observer however often rows are ticked and cleared)
            await ev(`(() => { const R = window.ResizeObserver; window.__liveRO = new Set(); window.ResizeObserver = class extends R { constructor(cb) { super(cb); this.__sel = /--sel-up/.test(String(cb)); } observe(t, o) { if (this.__sel) window.__liveRO.add(this); return super.observe(t, o); } disconnect() { window.__liveRO.delete(this); return super.disconnect(); } }; return true; })()`);
            for (let k = 0; k < 4; k++) { await ev(`(() => { const rs = ${rows}; rs[rs.length - 1 - (${k} % 2)].querySelector('.dt-check input, .dt-mail-lead').click(); return true; })()`); await ev(framesJs(3)); }
            const live = await ev(`window.__liveRO.size`);
            check(live <= 1, at + 'ticking and clearing rows leaves at most one live selection observer, not one per mount: ' + live);
            await shot('needs_sticky_' + w);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_sticky_actions_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
