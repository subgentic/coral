// The "incomplete list" notes are gone from under Needs you (#14827, the operator: 'These are not that useful to show'). A computer that cuts its review list short used to say so twice, "This computer returned an
// incomplete list" and "... incomplete review list". Now: no such words at all; one quiet line, "This list is cut short. Use Filters to narrow it.", while a filter is not applied, and "Narrow the filters further." when one is on and the list is still cut; and
// nothing when the list is not cut. 1280 and 390 px; the computer's page is a fixture with truncated: true.
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [], team = 'cut-' + Date.now().toString(36), T = '#group-table-view', S = `(window.__coralStatic || '/static/')`;
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const words = () => ev(`(() => { const t = document.querySelector('${T}').textContent.replace(/\\s+/g, ' '); return { incomplete: /incomplete (review )?list/i.test(t), cut: [...document.querySelectorAll('${T} .inbox-cut-short')].map(e => e.textContent.trim()) }; })()`);
    const open = async (w, mobile, truncated) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), hex = n => n.toString(16).padStart(64, '0');
            const items = [1, 2].map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'Ready?', uri: 'coral://artifacts/' + hex(i) }));
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}, { truncated: ${truncated} }) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin); if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items, has_more: false }); return original(url, opts); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 2`, 'two rows', 15000);
        await ev(framesJs(6));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await open(w, mobile, true);
            let g = await words();
            check(!g.incomplete, at + 'no "incomplete list" words under Needs you, whichever list it was');
            check(g.cut.length === 1 && g.cut[0] === 'This list is cut short. Use Filters to narrow it.', at + 'a cut list with no filter says so once: ' + JSON.stringify(g.cut));
            await shot(`needs-cut-list-${w}`);
            // a filter on and the list still cut: the same one line, worded for it
            await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'plan'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(framesJs(8));
            g = await words();
            check(!g.incomplete && g.cut.length === 1 && g.cut[0] === 'This list is cut short. Narrow the filters further.', at + 'with a filter on and the list still cut, the one line says to narrow it further (UI Accessibility): ' + JSON.stringify(g));
            // a list that is not cut: nothing
            await open(w, mobile, false);
            g = await words();
            check(!g.incomplete && g.cut.length === 0, at + 'a list that is not cut says nothing: ' + JSON.stringify(g));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_cut_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
