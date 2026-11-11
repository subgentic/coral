// Needs you bulk bar stays out of the way (#15339, walk 23 H3): ticking a row does not move the list (it moved 84 px at 1280, 4 px at 1920, so the next click landed on another row), and unticking it puts everything back.
// Review rows stubbed in the page. 1920 and 1280 px with a mouse. Drives Chrome over CDP through agent_view_harness.js.
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
        for (const [w, h, mobile] of [[1920, 1080, false], [1280, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])]; window.__needsItems = items;
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
            const tops = () => ev(`(() => { const rows = [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')]; return { tops: rows.map(r => Math.round(r.getBoundingClientRect().top)), bar: !!document.querySelector('.dt-bar, .team-tb-selection'), tb: [...document.querySelectorAll('.gt-toolbar, .gt-toolbar > *, .dt-bar')].filter(e => e.getClientRects().length).map(e => e.className.toString().slice(0, 24) + ':' + Math.round(e.getBoundingClientRect().top) + '+' + Math.round(e.getBoundingClientRect().height)), text: (document.querySelector('.dt-bar-count') || {}).textContent || '' }; })()`);
            const before = await tops();
            await ev(`document.querySelector('${T} tbody tr .dt-check input').click(); true`); await ev(framesJs(4));
            const after = await tops();
            check(after.bar && /1 selected/.test(after.text), at + 'the bar says 1 selected: ' + JSON.stringify(after));
            check(JSON.stringify(after.tops) === JSON.stringify(before.tops), at + 'ticking a row does not move the list (walk 23 H3): ' + JSON.stringify({ before: before.tops, after: after.tops }));
            // a ticked row that is gone is not still counted: tick two, answer one elsewhere (it leaves the feed), the count says 1
            await ev(`document.querySelectorAll('${T} tbody tr .dt-check input')[1].click(); true`); await ev(framesJs(3));
            check(/2 selected/.test((await tops()).text), at + 'two ticked say 2 selected: ' + JSON.stringify(await tops()));
            await ev(`{ const names = [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].filter(r => r.querySelector('.dt-check input')?.checked).map(r => r.textContent); const i = window.__needsItems.findIndex(a => names.some(n => n.includes(a.name))); if (i < 0) throw new Error('no ticked plan row: ' + names.join('|').slice(0, 200)); window.__needsItems.splice(i, 1); } import(${S} + 'inbox_reviews.js').then(async m => { m.reviewsChangedOnServer(); await m.refreshReviews(true); return import(${S} + 'inbox_tab.js'); }).then(m => m.selectInboxTab('needs')).then(() => true)`); await ev(framesJs(6));
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 3`, at + 'the list without the answered row (rows: ' + await ev(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length`) + ')', 10000);
            const gone = await tops();
            check(!gone.bar || /^1 selected/.test(gone.text), at + 'the count follows the rows that are left (1 selected, not 2): ' + JSON.stringify(gone));
            await ev(`document.querySelector('${T} .dt-bar-clear, ${T} .dt-bar button')?.click(); true`);
            await ev(`document.querySelector('${T} tbody tr .dt-check input').click(); true`); await ev(framesJs(4));
            const back = await tops();
            check(JSON.stringify(back.tops) === JSON.stringify(before.tops.slice(0, back.tops.length)) && !back.bar, at + 'unticking it puts everything back: ' + JSON.stringify({ before: before.tops, back: back.tops, bar: back.bar }));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_bulk_steady_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
