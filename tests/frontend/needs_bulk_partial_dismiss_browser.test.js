// Needs you bulk Dismiss that skips a row names it (#15339, walk 23 H4): selecting the Welcome items (all six; the first is read with its own Got it button, the others can be dismissed) and pressing Dismiss dismisses what can be dismissed and the notice says
// which row was skipped and what to press instead ('Welcome to Coral: use Got it'), (Undo of a dismissed review file or question is in needs_bulk_dismiss_undo.) The settings save is answered in the page, so the server's setting is never touched. 1280 px, mouse.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'partial-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1280, 800, false]]) {
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
            await ev(`(() => { const real = window.fetch.bind(window); window.fetch = (u, o) => String(u).includes('/api/settings') && o && o.method === 'PUT' ? Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })) : real(u, o); return true; })()`);
            await ev(`import(${S} + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`!!document.querySelector('${T} tbody tr[data-welcome-id], ${T} tbody tr[data-key^="welcome"]')`, at + 'the Welcome row', 15000);
            await ev(`[...document.querySelectorAll('${T} tbody tr[data-key*=":welcome:"] .dt-check input')].forEach(i => { if (!i.checked) i.click(); }); true`); await ev(framesJs(4));
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => /^Dismiss/.test(b.getAttribute('aria-label') || b.textContent.trim()))?.click(); true`); await ev(framesJs(3));
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => /^(Dismiss|Yes)/.test(b.textContent.trim()) && b !== document.activeElement)?.click(); true`).catch(() => {});
            await waitFor(`/Dismissed \\d+ of \\d+/.test(document.body.innerText)`, at + 'the partial notice (' + await ev(`JSON.stringify({ ticked: document.querySelectorAll('${T} .dt-check input:checked').length, bar: (document.querySelector('.dt-bar') || {}).innerText, said: (document.body.innerText.match(/Dismissed[^\\n]*/) || [''])[0] })`) + ')', 10000);
            const toast = await ev(`(document.body.innerText.match(/Dismissed \\d+ of \\d+[^\\n]*/) || [''])[0]`);
            check(/Welcome to Coral: use Got it/.test(toast), at + 'the notice names the skipped row and what to press: ' + JSON.stringify(toast));
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_bulk_steady_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
