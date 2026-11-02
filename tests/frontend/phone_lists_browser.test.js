// The shared phone form of a team's Tasks and Artifacts tabs (#12230, the operator: the same as Goals): rows edge to edge like the chat (no bordered card, no sort bar), the toolbar one line (the search, the filter
// icon, a compact + for the action), no Select button and no row checkboxes, and a long press selects a row with the bar of Needs you. Real tasks on the isolated server; the artifacts list stubbed in the page.
// 390 and 430 px as touch, 1280 as a mouse (the desktop keeps its table and its buttons). Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'phonelists-' + Date.now().toString(36), failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    const api = (m, path, body) => ev(`fetch('/api/board/${B}' + ${JSON.stringify(path)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);
    const stubArtifacts = `(() => { const hex = n => n.toString(16).padStart(64, '0'), items = [1, 2, 3].map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: [], produced_by: 'Boss', task_id: i, task_title: 'Task ' + i, uri: 'coral://artifacts/' + hex(i) }));
        const original = window.fetch; window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin); if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${B}/artifacts') return Promise.resolve(new Response(JSON.stringify({ project: '${B}', artifacts: items, has_more: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })); return original(url, opts); }; })();`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        await api('POST', '/subscribe', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-' + B });
        for (const t of ['Build the thing', 'Fix the bug', 'Write docs']) check((await api('POST', '/tasks', { subscriber_id: 'Operator', title: t, created_by: 'Operator', priority: 'medium', assigned_to: 'Boss' })).status < 300, 'made task ' + t);
        for (const tab of ['tasks', 'artifacts']) for (const [w, mobile] of [[390, true], [430, true], [1280, false]]) {
            const at = `${tab} ${w} px: `, P = `#team-panel-${tab}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const stub = tab === 'artifacts' ? (await Page.addScriptToEvaluateOnNewDocument({ source: stubArtifacts })).identifier : null; // the list route stood in before the page's own scripts
            await Page.navigate({ url: BASE + '/team/' + B + '/' + tab }); await Page.loadEventFired(); await install(); await coralReady(ev);
            if (stub) await Page.removeScriptToEvaluateOnNewDocument({ identifier: stub });
            await waitFor(`document.querySelectorAll('${P} tbody tr').length >= 3`, at + 'the rows', 15000).catch(() => check(false, at + 'the rows did not appear'));
            await ev(framesJs(6));
            const m = await ev(`(() => { const t = document.querySelector('${P}'), box = t && t.querySelector('.dt-box'); if (!box) return null; const r = e => e.getBoundingClientRect(), vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
                const bar = t.querySelector('.list-bar-search-row, .team-toolbar-row'), kids = bar ? [...bar.children].filter(vis) : [];
                return { boxLeft: Math.round(r(box).left), boxW: Math.round(r(box).width), vw: innerWidth, radius: getComputedStyle(box).borderTopLeftRadius, checks: [...t.querySelectorAll('input[type=checkbox]')].filter(vis).length, selectBtn: [...t.querySelectorAll('button')].filter(b => vis(b) && /^Select$/.test(b.textContent.trim())).length, sortBar: !!t.querySelector('.dt-sortbar') && vis(t.querySelector('.dt-sortbar')), tops: [...new Set(kids.map(k => Math.round(r(k).top / 4)))].length, rows: t.querySelectorAll('tbody tr').length, mail: box.classList.contains('dt-mail-on') }; })()`);
            check(!!m, at + 'the tab has its table'); if (!m) continue;
            if (mobile) {
                check(m.boxLeft === 0 && m.boxW === m.vw && m.radius === '0px', at + 'rows edge to edge, no card: ' + JSON.stringify(m));
                check(m.checks === 0 && m.selectBtn === 0 && !m.sortBar, at + 'no checkboxes, no Select button, no sort bar: ' + JSON.stringify([m.checks, m.selectBtn, m.sortBar]));
                check(m.tops === 1, at + 'the toolbar is one line: ' + m.tops + ' lines');
                const at1 = await ev(`(() => { const r = document.querySelector('${P} tbody tr .dt-mail-title, ${P} tbody tr .dt-primary').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
                const tt = type => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x: at1.x, y: at1.y, id: 1 }] });
                await tt('touchStart'); await new Promise(r => setTimeout(r, 700)); await tt('touchEnd'); // sleep-ok: a long press is a held finger
                await waitFor(`/1 selected/.test(document.querySelector('${P}')?.textContent || '')`, at + 'a long press selects the row', 5000).catch(() => check(false, at + 'a long press selects the row (no "1 selected" bar)'));
            } else {
                check(!m.mail && m.boxLeft > 0, at + 'a desktop keeps its table: ' + JSON.stringify(m));
            }
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('phone_lists_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
