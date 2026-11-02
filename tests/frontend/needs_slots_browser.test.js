// Needs you buttons are not "all over the place" (#11630, the operator): in the wide table every button is at the same x on every row, whether the row is read (it has a three dots), starred or a question to the
// operator: Approve (or Answer) in one slot, then a Request changes icon, a Save icon, the dots (option B, #12231); the question's Dismiss takes the two middle slots; the icons and the dots have their slots always. Also a subtitle's tooltip is set only while it is cut (a title left on a row
// showed "from Frontend Dev" over another row). 1440 and 1280 (the same four slots). Review rows and a question stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const team = 'slots-' + Date.now().toString(36);
    const check = (ok, what) => { if (!ok) failures.push(what); };
    const T = '#group-table-view';
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 800, false], [1280, 800, false]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Frontend Dev', job_title: 'Dev' }) }).then(r => r.status)`);
            await ev(`(() => { const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const hex = n => n.toString(16).padStart(64, '0'), ago = m => new Date(Date.now() - m * 60000).toISOString();
                const item = (i, extra) => ({ id: hex(i), name: 'file-' + i + '.png', media_type: 'image/png', size: 30, created_at: ago(30 + i), source: 'upload', available: true, tags: ['for review'], uploader: 'Frontend Dev', question: 'Approve file ' + i + '?', ...extra });
                const items = [item(1, { tags: ['for review', 'read'] }), item(2, {}), item(3, { starred: true }), item(4, {}), item(5, { tags: ['for review', 'read'], starred: true })];
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin), method = (opts.method || 'GET').toUpperCase();
                    if (method === 'GET' && u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: items.filter(a => !u.searchParams.has('tag') || a.tags.includes(u.searchParams.get('tag'))), has_more: false });
                    if (u.pathname === '/api/operator-asks') return json([{ board: '${team}', kind: 'ask', id: 41, asker: 'Lead', text: 'Which port should the test server use?', at: ago(20) }]);
                    return original(url, opts); };
                return true; })()`);
            await ev(`localStorage.setItem('coral-inbox-needs-filters', JSON.stringify({ sort: 'oldest' })); window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('${T} tbody tr').length === 6`, at + 'five reviews and a question', 15000);
            await ev(framesJs(4));
            const xs = await ev(`(() => { const slot = (b) => { const t = b.textContent.trim(); return b.classList.contains('inbox-row-more-toggle') ? 'more' : t === 'Approve' || t === 'Answer' ? 'approve' : t === 'Dismiss' ? 'dismiss' : /^Request changes/.test(b.getAttribute('aria-label') || '') ? 'changes' : b.classList.contains('inbox-bookmark') ? 'save' : ''; };
                const out = {}; for (const tr of document.querySelectorAll('${T} tbody tr')) for (const b of tr.querySelectorAll('button')) { if (!b.getClientRects().length) continue; const s = slot(b); if (s) (out[s] = out[s] || []).push(Math.round(b.getBoundingClientRect().left)); } return out; })()`);
            for (const s of ['approve', 'changes', 'more', 'save']) {
                const v = xs[s] || [];
                check(v.length > 0 && new Set(v).size === 1, at + `every ${s} button is at the same x on every row: ${JSON.stringify(v)}`);
            }
            check(new Set(xs.dismiss || []).size === 1 && (xs.dismiss || []).length === 1, at + 'the question\'s Dismiss is in its own slot, between Approve and the dots: ' + JSON.stringify(xs.dismiss)); // the reviews' Dismiss is in the dots now (option B, #12231)
            const titled = await ev(`[...document.querySelectorAll('${T} .dt-subtitle')].filter(s => s.title && s.scrollWidth <= s.clientWidth && s.title === s.textContent).length`);
            check(titled === 0, at + 'no subtitle carries a title it does not need: ' + titled);
            await shot(`needs-slots-${w}`);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_slots_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
