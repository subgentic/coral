// Needs you buttons are not "all over the place" (#11630, the operator): in the wide table every button is at the same x on every row, whether the row is read (it has a three dots), starred or a question to the
// operator: Approve (or Answer) in one slot, then Changes, Deny, Ignore, the dots; a star and the dots have their slots always. Also a subtitle's tooltip is set only while it is cut (a title left on a row
// showed "from Frontend Dev" over another row). 1440 (the four words) and 1280 (Approve, Changes, the dots). Review rows and a question stubbed in the page. Drives Chrome over CDP through agent_view_harness.js.
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
            const xs = await ev(`(() => { const slot = (b) => { const t = b.textContent.trim(); return b.classList.contains('inbox-row-more-toggle') ? 'more' : t === 'Approve' || t === 'Answer' ? 'approve' : ['Changes', 'Deny', 'Ignore'].includes(t) ? t.toLowerCase() : b.classList.contains('dt-star') ? 'star' : ''; };
                const out = {}; for (const tr of document.querySelectorAll('${T} tbody tr')) for (const b of tr.querySelectorAll('button')) { const s = slot(b); if (s) (out[s] = out[s] || []).push(Math.round(b.getBoundingClientRect().left)); } return out; })()`);
            for (const s of ['approve', 'changes', ...(w >= 1360 ? ['deny', 'ignore'] : []), 'more', 'star']) {
                const v = xs[s] || [];
                check(v.length > 0 && new Set(v).size === 1, at + `every ${s} button is at the same x on every row: ${JSON.stringify(v)}`);
            }
            if (w >= 1360) check(new Set(xs.ignore || []).size === 1 && (xs.ignore || []).length === 6, at + 'the question\'s Ignore is in the same slot as the others: ' + JSON.stringify(xs.ignore));
            const titled = await ev(`[...document.querySelectorAll('${T} .dt-subtitle')].filter(s => s.title && s.scrollWidth <= s.clientWidth && s.title === s.textContent).length`);
            check(titled === 0, at + 'no subtitle carries a title it does not need: ' + titled);
            await shot(`needs-slots-${w}`);
            await removeBoards(ev, [team]).catch(() => {});
        }
    } finally { await ev(`localStorage.removeItem('coral-inbox-needs-filters'); true`).catch(() => {}); await client.close(); }
    if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
    console.log('needs_slots_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
