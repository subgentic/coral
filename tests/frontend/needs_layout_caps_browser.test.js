// Needs you at 1920 px (#15339, walk 23 M11, L17): the Filters panel's selects are not the panel's whole width (770 px), and the table is not as wide as the screen (Time sat 1400 px from the title); with only Welcome items the
// Team column is still there, so the layout does not jump when the last review goes. Stubbed review rows and a stubbed settings save. 1920 px, mouse.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'caps-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1920, 1080, false]]) {
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
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length >= 3 && !!document.querySelector('${T} tbody tr:not(.dt-group) .inbox-answers, ${T} tbody tr:not(.dt-group) [data-on-click*="ask"], ${T} tbody tr:not(.dt-group) button')`, at + 'the review rows and the question', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const wrapW = () => ev(`Math.round(document.querySelector('${T} .inbox-needs-results').getBoundingClientRect().width)`);
            await ev(`(() => { const b = document.querySelector('[aria-controls=inbox-needs-menu]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`); await ev(framesJs(4));
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the panel opens
            const sel = await ev(`[...document.querySelectorAll('#inbox-needs-menu select')].map(e => Math.round(e.getBoundingClientRect().width))`);
            await Promise.resolve();
            check(sel.length > 0 && sel.every(x => x <= 420), at + 'the Filters selects are not the width of the panel (walk 23 M11): ' + JSON.stringify(sel) + ' ' + await ev(`JSON.stringify([...document.querySelectorAll('button')].filter(b => /Filter/.test(b.textContent + b.className)).map(b => b.className + '|' + b.textContent.trim().slice(0, 20) + '|' + b.getAttribute('aria-expanded')).concat([...document.querySelectorAll('select')].map(e => e.className + '@' + (e.closest('[class*=menu],[class*=panel]') || {}).className)))`));
            await ev(`(() => { const b = document.querySelector('[aria-controls=inbox-needs-menu]'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); return true; })()`);
            check(await wrapW() <= 1281, at + 'the table is no wider than 1280 px on a 1920 screen (walk 23 L17): ' + await wrapW());
            // only Welcome items: no review rows, no questions
            await ev(`window.__needsItems.length = 0; (() => { const real = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })) : String(u).includes('/api/settings') && o && o.method === 'PUT' ? Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); })(); true`);
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`);
            await ev(`import(${S} + 'inbox_reviews.js').then(async m => { m.reviewsChangedOnServer(); await m.refreshReviews(true); await import(${S} + 'ask_ignore.js').then(a => a.refreshOperatorAsks(true)); return import(${S} + 'inbox_tab.js'); }).then(m => m.selectInboxTab('needs')).then(() => true)`); await ev(framesJs(6));
            await waitFor(`document.querySelectorAll('${T} tbody tr[data-key*=":welcome:"]').length > 0 && !document.querySelector('${T} tbody tr:not([data-key*=":welcome:"]):not(.dt-group)')`, at + 'only Welcome items (' + await ev(`JSON.stringify([...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].map(r => r.dataset.key || r.className))`) + ')', 15000);
            const heads = await ev(`[...document.querySelectorAll('${T} th[data-key]')].map(h => h.dataset.key)`);
            check(heads.includes('team'), at + 'the Team column is still there with only Welcome items (walk 23 L17): ' + JSON.stringify(heads) + await ev(`document.querySelector('${T} table, ${T} [role=table], ${T} [role=grid]')?.outerHTML.slice(0, 600)`));
            check(await wrapW() <= 1281, at + 'and the table is no wider than 1280 px: ' + await wrapW());
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_layout_caps_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
