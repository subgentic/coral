// Needs you rows on a computer are cards (#15162, the Operator's approved bottom-row layout; it replaces #11669's hover-only actions): the item and its words on top, then ONE line along the bottom with how long it has
// waited at the left and the buttons at the right, always drawn (a pointer's hover changes nothing, a keyboard user finds them without hovering). Every row has the same shape whatever its kind: no column header that
// comes and goes. Review rows (one read) stubbed in the page. 1440, 1280 and 1024 with a mouse. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'hover-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: `localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' }));` });
        for (const [w, h, mobile] of [[1440, 800, false], [1280, 800, false], [1024, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Plan Writer', job_title: 'Writer' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0');
                const item = (i, tags) => ({ id: hex(i), name: 'plan-' + i + '.md', media_type: 'text/markdown', size: 30, created_at: new Date(Date.now() - (9 - i) * 60000).toISOString(), source: 'upload', available: true, tags, produced_by: 'Plan Writer', review_question: 'Ship plan ' + i + '?' });
                const items = [item(1, ['for review']), item(2, ['for review', 'read']), item(3, ['for review'])];
                window.fetch = (url, opts = {}) => { const reviewPageURL = new URL(String(url), location.href), reviewPage = reviewPageURL.pathname === '/api/team-artifacts' ? window.__reviewFixturePage(reviewPageURL, location.href, {'${team}': items}) : null; if (reviewPage) return json(reviewPage); const u = window.__reviewFixtureURL(String(url), location.origin);
                    if ((opts.method || 'GET') === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    return original(url, opts); };
                return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 3`, at + 'three review rows', 15000);
            await ev(framesJs(4));
            await ev(`(() => { const st = document.createElement('style'); st.textContent = '*, *::before, *::after { transition: none !important; }'; document.head.append(st); return true; })()`);
            const card = n => ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')].find(r => r.textContent.includes('plan-${n}.md')), rr = tr.getBoundingClientRect(), approve = tr.querySelector('button[aria-label="Approve: plan-${n}.md"]'), br = approve.getBoundingClientRect(), when = tr.querySelector('.dt-line-3, td:last-child'), name = tr.querySelector('.dt-primary, .inbox-review-item, td'), nr = name.getBoundingClientRect(); const buttons = [...tr.querySelectorAll('.dt-line-3 button, td:last-child button')].map(b => b.getBoundingClientRect()); const right = Math.max(...buttons.map(b => b.right)); return { shown: approve.getClientRects().length > 0, opacity: Number(getComputedStyle(approve.closest('.inbox-review-actions') || approve).opacity), below: br.top >= nr.bottom - 1, inside: br.right <= rr.right + 1 && br.left >= rr.left - 1, right: Math.round(rr.right - right), waited: /waiting/.test(tr.textContent), tab: approve.tabIndex }; })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 5, y: 5 }); await ev(framesJs(3)); // the pointer is nowhere near a row
            const rows = [await card(1), await card(2), await card(3)];
            check(rows.every(r => r.shown && r.opacity === 1 && r.tab === 0), at + 'the buttons are drawn at rest, nothing waits for a hover: ' + JSON.stringify(rows));
            check(rows.every(r => r.below && r.inside), at + 'they are on the row\'s bottom line, under the item, inside the row: ' + JSON.stringify(rows));
            check(new Set(rows.map(r => r.right)).size === 1, at + 'every row\'s buttons end at the same distance from its right edge: ' + JSON.stringify(rows.map(r => r.right)));
            check(rows.every(r => r.waited), at + 'how long it has waited is on the row');
            const heads = await ev(`[...document.querySelectorAll('${T} thead th')].filter(t => t.getClientRects().length).map(t => t.textContent.trim())`);
            check(heads.length === 0, at + 'no column header that comes and goes: ' + JSON.stringify(heads));
            const hov = await ev(`(() => { const tr = [...document.querySelectorAll('${T} tbody tr')][1], r = tr.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 10) }; })()`);
            await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: hov.x, y: hov.y }); await ev(framesJs(3));
            const over = [await card(1), await card(2), await card(3)];
            check(JSON.stringify(over) === JSON.stringify(rows), at + 'hovering a row changes nothing: ' + JSON.stringify(over));
            const skip = await ev(`(() => { const a = document.querySelector('#group-table-view .skip-link'); if (!a) return null; a.click(); const f = document.activeElement; return { text: a.textContent, inRow: !!f.closest('tbody tr'), tag: f.tagName }; })()`);
            check(skip && skip.inRow && /Skip to the list/.test(skip.text), at + 'a skip link before the filters puts the keyboard on the first row\'s buttons (walk 7 M3): ' + JSON.stringify(skip));
            await shot(`needs-card-rows-${w}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    if (failures.length) { console.error('FAIL\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('needs_card_rows_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
