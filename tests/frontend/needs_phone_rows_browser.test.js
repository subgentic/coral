// #11642 (the operator, on the phone's Needs you rows): each row's main button is one size at one place, the right edge, the same on every row; no Ignore (or Dismiss) button on a phone row: a swipe to the left ignores it
// with Undo, and Ignore stays in the three-dot menu. Welcome items, a file for review and a question alike, at 390 and 360 px. The review artifacts, the questions and the welcome setting are put in the page as the
// server answers them (the artifact list and /api/operator-asks stubbed, the welcome items from the page's settings); the swipe is a real touch drag through CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'phone-rows-' + Date.now().toString(36);
    const T = '#group-table-view';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [390, 360]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            assert.equal(await ev(`fetch('/api/board/${team}/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscriber_id:'Review Writer',job_title:'Writer'})}).then(r=>r.status)`), 200);
            await ev(`(() => {
                const mk = n => ({ id: n.toString(16).padStart(64, '0'), name: 'Phone review ' + n + '.txt', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (10 - n) * 60000).toISOString(), tags: ['for review'], available: true, uri: 'coral://artifacts/' + n.toString(16).padStart(64, '0'), produced_by: 'Review Writer', session_id: 'rw-1', task_id: n });
                window.__reviewItems = [mk(1), mk(2)]; window.__asks = [{ board: '${team}', kind: 'ask', id: 71, asker: 'Lead', text: 'Which port should the test server use?', at: '2026-10-31T01:00:00Z' }, { board: '${team}', kind: 'ask', id: 72, asker: 'Docs', text: 'Which heading style?', at: '2026-10-31T02:00:00Z' }];
                window.__calls = []; const original = window.fetch.bind(window), json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u), x = new URL(url, location.origin), method = o.method || 'GET';
                    if (x.pathname === '/api/board/${team}/artifacts') { const items = window.__reviewItems.filter(a => !x.searchParams.has('tag') || a.tags.includes(x.searchParams.get('tag'))); return json({ project: '${team}', artifacts: items, has_more: false }); }
                    const rv = x.pathname.match(/^\\/api\\/board\\/${team}\\/artifacts\\/([0-9a-f]+)\\/review$/);
                    if (rv && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ review: rv[1], body }); return json({ ok: true }); }
                    if (url === '/api/operator-asks') return json(window.__asks);
                    const m = url.match(/\\/api\\/board\\/${team}\\/asks\\/(\\d+)\\/close$/);
                    if (m && method === 'POST') { const body = JSON.parse(o.body); window.__calls.push({ id: Number(m[1]), body }); window.__asks = window.__asks.filter(a => a.id !== Number(m[1])); return json({ ok: true, closed_by: 'Operator' }); }
                    return original(u, o); };
                window.__T = null; return true; })()`);
            await ev(`import((window.__coralStatic || '/static/') + 'state.js').then(m => { m.state.settings = { ...m.state.settings, inbox_welcome: 'on', inbox_welcome_done: '' }; return true; })`);
            await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => { m.updateInboxTab(); return m.selectInboxTab('needs'); }).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length >= 5 && !!document.querySelector('${T} button[aria-label^="Approve"]') && !!document.querySelector('${T} button[aria-label^="Answer the question"]')`, at + 'welcome, review and question rows', 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the table settles after its first draw
            const rows = await ev(`[...document.querySelectorAll('${T} tbody tr')].map(r => { const main = r.querySelector('.inbox-main-action'), b = main && main.getBoundingClientRect(); return { name: (r.querySelector('.inbox-review-name') || r).textContent.trim().slice(0, 30), main: main ? { x: Math.round(b.left * 10) / 10, w: Math.round(b.width * 10) / 10, right: Math.round(b.right * 10) / 10, label: main.textContent } : null, ignoreButtons: [...r.querySelectorAll('button:not(.menu-item)')].filter(x => /^(Ignore|Dismiss)/.test(x.textContent.trim()) || /^(Ignore|Dismiss)\\b/.test(x.getAttribute('aria-label') || '')).length }; }).filter(r => r.main || r.ignoreButtons)`);
            assert.ok(rows.length >= 5, at + 'welcome, review and question rows are all there: ' + JSON.stringify(rows));
            const kinds = new Set(rows.map(r => r.main && r.main.label));
            assert.ok(kinds.has('Approve') && kinds.has('Answer') && [...kinds].some(k => k && !['Approve', 'Answer'].includes(k)), at + 'review, question and welcome rows: ' + JSON.stringify([...kinds]));
            assert.equal(new Set(rows.map(r => r.main.x)).size, 1, at + 'the main button is at the same x on every row: ' + JSON.stringify(rows));
            assert.equal(new Set(rows.map(r => r.main.w)).size, 1, at + 'and the same width on every row: ' + JSON.stringify(rows));
            // the right edge is the Actions cell's own content edge, to 8 px (QA's SHOULD, #11655): without the margin-inline-start:auto rules a row whose buttons are fewer ends short of it
            const edge = await ev(`[...document.querySelectorAll('${T} tbody tr')].filter(r => r.querySelector('.inbox-main-action')).map(r => { const td = r.querySelector('.inbox-review-actions').closest('td, .dt-td'), c = td.getBoundingClientRect(), pad = parseFloat(getComputedStyle(td).paddingRight) || 0, m = r.querySelector('.inbox-main-action').getBoundingClientRect(); return { cell: Math.round((c.right - pad) * 10) / 10, main: Math.round(m.right * 10) / 10 }; })`);
            assert.ok(edge.length >= 5 && edge.every(e => Math.abs(e.cell - e.main) <= 8), at + 'every main button ends within 8 px of its cell edge: ' + JSON.stringify(edge));
            const clip = await ev(`[...document.querySelectorAll('${T} .inbox-main-action')].map(b => [b.textContent, b.scrollWidth, b.clientWidth])`); assert.ok(clip.every(c => c[1] <= c[2] + 1), at + 'every main button shows its whole word: ' + JSON.stringify(clip));
            assert.ok(rows.every(r => r.ignoreButtons === 0), at + 'no Ignore or Dismiss button on a phone row: ' + JSON.stringify(rows));
            // Ignore stays in the menu
            await ev(`document.querySelector('${T} button[aria-label^="More actions for the question of Lead"]').click(); true`);
            await waitFor(`!!document.querySelector('${T} .inbox-row-more .menu:not([hidden]) .menu-item')`, at + 'the menu opens', 5000);
            const menu = await ev(`[...document.querySelectorAll('${T} .inbox-row-more .menu:not([hidden]) .menu-item')].map(b => b.textContent)`);
            assert.deepEqual(menu, ['Ignore'], at + 'the question row\'s menu has Ignore: ' + JSON.stringify(menu));
            await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); true`);
            // a real swipe to the left ignores the question, with Undo
            const rect = await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].find(x => x.querySelector('button[aria-label="Answer the question of Lead"]')); row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
            const touch = (type, x, y) => client.Input.dispatchTouchEvent({ type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
            await touch('touchStart', rect.x + rect.w - 20, rect.y);
            for (let i = 1; i <= 8; i++) await touch('touchMove', rect.x + rect.w - 20 - i * (rect.w * 0.07), rect.y);
            await touch('touchEnd', 0, 0);
            await waitFor(`window.__calls.some(c => c.id)`, at + 'the swipe closed the question', 8000);
            const call = await ev('window.__calls.find(c => c.id)');
            assert.ok(call.id === 71 && !call.body.undo, at + 'it is Lead\'s question, closed, not undone: ' + JSON.stringify(call));
            const toast = await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Ignored the question of Lead/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'a toast with Undo', 8000);
            // and a swipe on a review file
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list is redrawn once the closed question is gone
            const r2 = await ev(`(() => { const row = [...document.querySelectorAll('${T} tbody tr')].find(x => x.querySelector('button[aria-label^="Approve: Phone review 1"]')); row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
            await touch('touchStart', r2.x + r2.w - 20, r2.y);
            for (let i = 1; i <= 8; i++) await touch('touchMove', r2.x + r2.w - 20 - i * (r2.w * 0.07), r2.y);
            await touch('touchEnd', 0, 0);
            await waitFor(`window.__calls.some(c => c.review && c.body.decision === 'ignore')`, at + 'the review file was ignored through the review route', 8000);
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => /Ignored: Phone review 1/.test(t.textContent) && [...t.querySelectorAll('button')].some(b => b.textContent.trim() === 'Undo'))`, at + 'the review file is ignored with Undo', 8000);
            await removeBoards(ev, [team]).catch(() => {});
        }
        console.log('\nPASS the phone rows: one main button, no Ignore button, a swipe ignores');
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
