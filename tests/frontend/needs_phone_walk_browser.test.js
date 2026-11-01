// The v2.0.23 phone walk's three findings on a Needs you row (#11775, #11776), at 390 px with a real file of three versions: "2 earlier versions" is on the row (it was pushed out of sight by the file's name), the sender is not cut
// ("Orchestrat…") while there is room beside it, and a short question to the Operator is said once, not as the row's name and again under it. Review rows and an operator question stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'walk-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 800, true], [360, 800, true], [1440, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const v = i => ({ id: hex(i), name: 'plan.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'Is the launch plan ready to go to the whole team, with the three milestones as written, and who should announce it first?' });
                const items = [v(1), v(2), v(3)];
                window.__asks = [{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/operator-asks') return json(window.__asks);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await ev(`import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 2`, at + 'one row for the three versions and one for the question', 15000);
            await ev(framesJs(4));
            await shot(`needs-phone-walk-${w}`);
            const m = await ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr')], plan = rows.find(r => r.textContent.includes('plan.md')), ask = rows.find(r => r.textContent.includes('Which port')), q = (tr, s) => tr.querySelector(s), box = tr => tr.getBoundingClientRect(), from = q(plan, '.inbox-review-from'), earlier = q(plan, '.inbox-review-earlier'), item = q(plan, '.inbox-review-item');
                return { from: from.textContent.replace(/\\s*\\u00b7$/, ''), fromCut: from.scrollWidth > from.clientWidth + 1, fromW: Math.round(from.getBoundingClientRect().width),
                    earlier: earlier ? earlier.textContent.replace(/\\s+/g, ' ').trim() : null, earlierSeen: earlier ? earlier.getBoundingClientRect().right <= item.getBoundingClientRect().right + 1 && earlier.getBoundingClientRect().width > 0 : false,
                    askText: ask.textContent.replace(/\\s+/g, ' '), askCount: (ask.textContent.match(/Which port should the test server use\\?/g) || []).length }; })()`);
            check(m.earlier === '· 2 earlier versions' || /2 earlier versions/.test(String(m.earlier)), at + 'the row of three versions says "2 earlier versions": ' + JSON.stringify(m));
            check(m.earlierSeen, at + 'and the words are inside the row, not pushed out of it: ' + JSON.stringify(m));
            check(m.from === 'Orchestrator' && !m.fromCut, at + 'the sender is not cut: ' + JSON.stringify([m.from, m.fromCut, m.fromW]));
            check(m.askCount === 1, at + `a short question is said once on its row (${m.askCount} times): ${m.askText.slice(0, 160)}`);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_phone_walk_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
