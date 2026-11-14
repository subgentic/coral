// Select several Needs you items and dismiss them at once, on a desktop as on a phone (#15015, the Operator): Select starts a select mode (a checkbox per row, Select all, the count), a shift-click selects a range, Dismiss acts on all of them
// (one request per item through the row's own route; the notice says how many and holds Undo), and Done or Escape leaves select mode. 1280 px (the mouse) and 390 px (the touch bar). The fixture and its routes are the bulk Undo suite's.
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const rowNames = () => ev(`[...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].map(r => (r.textContent.match(/bulk-0\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const original = window.fetch, json = (b, st = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = i => ({ id: hex(i), name: 'bulk-0' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags: ['for review', 'internal'], uri: 'coral://artifacts/' + hex(i), produced_by: 'Writer', session_id: 's' + i });
                window.__items = [1, 2, 3].map(item); window.__ntDelay = 0;
                window.fetch = (url, opts = {}) => { const pageURL = new URL(String(url), location.href), page = pageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(pageURL, location.href, {'bulk': window.__items}) : null; if (page) return new Promise(done => setTimeout(() => done(json(page)), window.__ntDelay || 0)); /* sleep-ok: fixture response delay preserves the stale-read ordering */ const u = window.__reviewFixtureURL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (u.pathname.startsWith('/api/artifacts/')) return Promise.resolve(new Response('Review preview text', { headers: { 'Content-Type': 'text/plain' } }));
                    if (u.pathname === '/api/team-artifacts') return new Promise(done => setTimeout(() => done(json({ artifacts: [], has_more: false })), window.__ntDelay || 0));
                    const m = u.pathname.match(/^\\/api\\/board\\/bulk\\/artifacts(?:\\/([0-9a-f]{64})\\/review)?$/);
                    if (!m) return original(url, opts);
                    if (!m[1]) return json({ project: 'bulk', artifacts: window.__items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    const it = window.__items.find(a => a.id === m[1]), body = opts.body ? JSON.parse(opts.body) : {};
                    if (body.decision === 'ignore') it.tags = it.tags.filter(x => x !== 'for review').concat('ignored');
                    if (body.decision === 'unignore') it.tags = it.tags.filter(x => x !== 'ignored').concat('for review');
                    return json({ id: it.id, tags: it.tags }); }; return true; })()`);

            await ev(`fetch('/api/board/bulk/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Writer', job_title: 'W' }) }).then(r => r.status)`);
            await ev(`localStorage.removeItem('coral-inbox-needs-filters'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length >= 3`, `${at}three review rows`, 15000);
            // a desktop's table has its checkbox column (and Select all in the header) as the tasks table does; a phone selects by a long press (the first checkbox tap here)
            if (!mobile) await waitFor(`document.querySelectorAll('${T} tbody .dt-check input').length >= 3 && !!document.querySelector('${T} thead .dt-check-all')`, `${at}a checkbox per row and Select all in the header`, 8000);
            const pick = (n, shift) => ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].find(r => /${n}/.test(r.textContent)), box = row.querySelector('button[role="checkbox"], .dt-check input'); box.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${!!shift} })); return true; })()`);
            await pick('bulk-01');
            await waitFor(`[...document.querySelectorAll('${T} tbody tr:not(.dt-group)')].some(r => /bulk-01/.test(r.textContent) && (r.querySelector('[aria-checked="true"]') || r.querySelector('.dt-check input:checked')))`, `${at}bulk-01 is selected`, 6000);
            await pick('bulk-03', true); // a shift-click selects the range between
            await waitFor(`!!document.querySelector('.dt-bar') && /3 selected/.test(document.querySelector('.dt-bar').textContent)`, `${at}the range: 3 selected in the bar`, 8000);
            await pick('bulk-02'); // one off again
            await waitFor(`/2 selected/.test(document.querySelector('.dt-bar')?.textContent || '')`, `${at}2 selected after unticking one`, 6000);
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith('Dismiss')).click(); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 1`, `${at}the two dismissed files leave Needs you`, 10000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Dismissed 2/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, `${at}the notice says Dismissed 2, with Undo`, 8000);
            await ev(`[...document.querySelectorAll('.toast')].filter(t => /Dismissed 2/.test(t.textContent)).forEach(t => t.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); })); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr:not(.dt-group)').length === 3`, `${at}Undo brings both back`, 9000);
            check(JSON.stringify((await rowNames()).sort()) === JSON.stringify(['bulk-01', 'bulk-02', 'bulk-03']), `${at}the three files are the rows: ` + JSON.stringify(await rowNames()));
            await pick('bulk-02');
            await waitFor(`/1 selected/.test(document.querySelector('.dt-bar')?.textContent || '')`, `${at}one selected again`, 6000);
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => /^(Done|Cancel)$/.test((b.getAttribute('aria-label') || b.textContent).trim()))?.click(); true`);
            await waitFor(`!document.querySelector('.dt-bar') || document.querySelector('.dt-bar').hidden || !document.querySelector('.dt-bar').isConnected`, `${at}Done leaves the selection: no bar`, 6000);
            if (!mobile) { // Escape is a keyboard's (a phone's rows have no checkbox to focus)
                await pick('bulk-02');
                await waitFor(`/1 selected/.test(document.querySelector('.dt-bar')?.textContent || '')`, `${at}one selected again, for Escape`, 6000);
                await ev(`document.querySelector('${T} tbody tr:not(.dt-group) .dt-check input, ${T} tbody tr:not(.dt-group) [role=checkbox]').focus(); true`);
                await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
                await waitFor(`!document.querySelector('.dt-bar') || document.querySelector('.dt-bar').hidden || !document.querySelector('.dt-bar').isConnected`, `${at}Escape leaves the selection: no bar`, 6000);
            }
            await removeBoards(ev, ['bulk']).catch(() => {});
        }
    } finally { await removeBoards(ev, ['bulk']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_select_dismiss_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
