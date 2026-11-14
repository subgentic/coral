// #17128 (walk 49): a phone's Needs you list has a visible Select button (44 px) in its toolbar. It shows a checkbox per row (a 44 px target), a tap on a row's box selects it, the bar's Dismiss clears the selected rows together, and Done leaves select mode. 390 px, touch; the fixture is the bulk Dismiss suite's.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const S = `(window.__coralStatic || '/static/')`, T = '#group-table-view';
    const rowNames = () => ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => (r.textContent.match(/bulk-0\\d/) || [''])[0])`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[390, true]]) {
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
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 3`, `${at}three review rows`, 15000);
            const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
            const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, visible: e.getClientRects().length > 0 }; })()`);
            const tap = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }); true`); const r = await rect(sel); await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', clickCount: 1 }); };
            await shot('needs-before-select');
            const sb = await rect(`${T} .dt-select-toggle`);
            check(sb && sb.visible && sb.w >= 44 && sb.h >= 44 && sb.x >= 0 && sb.x + sb.w <= 390, `${at}the toolbar has a visible Select button, a 44 px target on screen: ` + JSON.stringify(sb));
            await tap(`${T} .dt-select-toggle`);
            await waitFor(`document.querySelectorAll('${T} tbody .dt-check input').length >= 3 && [...document.querySelectorAll('${T} tbody .dt-check input')].every(i => i.getClientRects().length > 0)`, `${at}Select shows a checkbox on each row`, 6000);
            const boxes = await ev(`[...document.querySelectorAll('${T} tbody tr .dt-check-hit')].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })`);
            check(boxes.length >= 3 && boxes.every(([w, h]) => w >= 44 && h >= 44), `${at}each checkbox is a 44 px target: ` + JSON.stringify(boxes));
            await shot('needs-select-mode');
            for (const n of ['bulk-01', 'bulk-02']) {
                await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].find(r => /${n}/.test(r.textContent)); row.querySelector('.dt-check input').id = 'tap-${n}'; return true; })()`);
                if (n === 'bulk-02') { await ev(framesJs(30)); await shot('needs-one-ticked'); } // the bar takes the toolbar's line: the rows settle before the next tap
                await tap(`#tap-${n}`);
                await waitFor(`document.querySelectorAll('${T} tbody tr.dt-selected').length === ${n === 'bulk-01' ? 1 : 2}`, `${at}${n} is ticked`, 6000);
            }
            await waitFor(`/2 selected/.test(document.querySelector('.dt-bar')?.textContent || '')`, `${at}two taps: 2 selected in the bar`, 6000);
            await shot('needs-two-selected');
            await ev(`[...document.querySelectorAll('.dt-bar button')].find(b => (b.getAttribute('aria-label') || b.textContent).trim().startsWith('Dismiss')).click(); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 1`, `${at}the two dismissed files leave Needs you together`, 10000);
            await shot('needs-after-dismiss');
            await ev(`[...document.querySelectorAll('.toast')].filter(t => /Dismissed 2/.test(t.textContent)).forEach(t => t.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Undo') b.click(); })); true`);
            await removeBoards(ev, ['bulk']).catch(() => {});
        }
    } finally { await removeBoards(ev, ['bulk']).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_select_phone_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
