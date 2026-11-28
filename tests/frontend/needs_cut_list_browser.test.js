// The "incomplete list" notes are gone from under Needs you (#14827, the operator: 'These are not that useful to show'). A computer that cuts its review list short used to say so twice, "This computer returned an
// incomplete list" and "... incomplete review list". Now: no such words at all; one quiet line, "Showing 50 of 51" (#17450; it was "This list is cut short. Use Filters to narrow it.") with the computer's Show more under it; and
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
    const words = () => ev(`(() => { const t = document.querySelector('${T}').textContent.replace(/\\s+/g, ' '); return { incomplete: /incomplete (review )?list/i.test(t), cut: [...document.querySelectorAll('${T} .inbox-cut-short, ${T} .inbox-review-more')].map(e => ([...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') || e.textContent).trim()).filter(t => /^Showing/.test(t)) }; })()`);
    const open = async (w, mobile, truncated, itemCount = 51) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Orchestrator', job_title: 'Orchestrator' }) }).then(r => r.status)`);
        await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), hex = n => n.toString(16).padStart(64, '0');
            const items = Array.from({ length: ${itemCount} }, (_, n) => n + 1).map(i => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - i * 60000).toISOString(), source: 'upload', available: true, tags: ['for review'], produced_by: 'Orchestrator', review_question: 'Ready?', uri: 'coral://artifacts/' + hex(i) }));
            window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}, { truncated: ${truncated} }) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin); if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items, has_more: false }); return original(url, opts); }; return true; })()`);
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('${T} .nl-file').length >= ${Math.min(itemCount, 2)}`, 'review rows', 15000);
        await ev(framesJs(6));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const at = `${w} px: `;
            await open(w, mobile, true, 1);
            let g = await words();
            check(g.cut.length === 0, at + 'one returned item with no more rows has no cut-short warning: ' + JSON.stringify(g));
            await open(w, mobile, true);
            g = await words();
            check(!g.incomplete, at + 'no "incomplete list" words under Needs you, whichever list it was');
            check(g.cut.length === 1 && /^Showing 50 of 51( review items on .+)?\.( Narrow the filters further\.| Use Filters to narrow it\.)?$/.test(g.cut[0]) && await ev(`!![...document.querySelectorAll('${T} [data-review-more], #group-table-view [data-review-more]')].find(b => b.textContent === 'Show more')`), at + 'a cut list says how many it shows and has a Show more button, once (#17450: "Showing 50 of 51", or the approved footer, Showing 50 of 51 review items on a computer (mock #19808 v1, #19833); not "cut short"): ' + JSON.stringify(g.cut));
            // counts are numbers (#17450, N1): "50+" where more are not read yet, the same in the title, the sidebar row and the tab's name; the words "at least" are nowhere
            const nums = await ev(`(() => { const t = e => e ? e.textContent.replace(/\\s+/g, ' ').trim() : ''; const side = document.querySelector('.view-list-item[data-key="needs"], #group-table-view .view-list-item[data-key="needs"]'); return { page: t(document.querySelector('#group-table-view')), side: t(side), tab: (document.querySelector('[data-tab="hub-inbox"], #nav-tab-hub-inbox, .nav-tab[data-tab="hub-inbox"]') || {}).getAttribute ? document.querySelector('[data-tab="hub-inbox"], #nav-tab-hub-inbox, .nav-tab[data-tab="hub-inbox"]').getAttribute('aria-label') : '' }; })()`);
            check(!/at least/i.test(nums.page + ' ' + nums.side + ' ' + (nums.tab || '')), at + 'no "at least" in the Needs you page, its sidebar row or the Inbox tab\'s name: ' + JSON.stringify(nums).slice(0, 400));
            await shot(`needs-cut-list-${w}`);
            // a filter on and the list still cut: the same one line, worded for it
            await ev(`(() => { const i = document.getElementById('inbox-search'); i.value = 'plan'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await ev(framesJs(8));
            g = await words();
            check(!g.incomplete && g.cut.length === 1 && /^Showing 50 of 51( review items on .+)?\.( Narrow the filters further\.| Use Filters to narrow it\.)?$/.test(g.cut[0]), at + 'with a filter on and the list still cut, it says the same number: ' + JSON.stringify(g));
            // a list that is not cut: nothing
            await open(w, mobile, false);
            g = await words();
            check(!g.incomplete && g.cut.length === 0, at + 'a list that is not cut says nothing: ' + JSON.stringify(g));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_cut_list_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
