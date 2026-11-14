// Needs you's kind groups show their five oldest rows with a link for the rest, and Read all marks a group read in place (#16814, slice 3b of #16576). A real isolated board; only artifact storage and the question
// list are mocked, as inbox_kind_groups does. Eight unread files for review: Review shows five rows and "Show 3 more"; the link opens the rest ("Show fewer" shuts them again); the heading says "Read all 8"
// (the unread ones) and pressing it marks them read through the mark-read path, in place, with every row still there, nothing approved. A group of five or fewer has no link. 1280 and 390 px, dark and light.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');
const TEAM = 'kind-limit-' + Date.now().toString(36);
(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect({ kindLimit: true }); // the harness opens "Show N more" for other suites; this one is about the limit
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const names = `[...document.querySelectorAll('#group-table-view tbody tr.dt-row')].filter(tr => tr.getClientRects().length).map(tr => (tr.querySelector('.inbox-review-name') || tr).textContent.replace(/\\s+/g, ' ').trim()).filter(t => /^file-/.test(t)).map(t => t.slice(0, 7))`;
    const opened = async () => {
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        await ev(`localStorage.setItem('coral-inbox-group-mode', 'none'); localStorage.removeItem('coral-inbox-needs-filters'); true`);
        await ev(`(() => { window.__marked = []; const items = Array.from({ length: 8 }, (_, i) => ({ id: (i + 1).toString(16).padStart(64, '0'), name: 'file-' + String(i + 1).padStart(2, '0') + '.md', media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - (60 - i) * 60000).toISOString(), tags: ['for review'], starred: false, produced_by: 'Writer', available: true }));
            const original = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.href);
                if (u.pathname === '/api/team-artifacts') return json(window.__reviewFixturePage(u, location.href, { '${TEAM}': items }));
                if (u.pathname === '/api/operator-asks') return json([]);
                const tagPut = /\\/artifacts\\/([0-9a-f]{64})\\/tags$/.exec(u.pathname); if (tagPut && opts.method === 'PUT') { const tags = JSON.parse(opts.body).tags, it = items.find(x => x.id === tagPut[1]); if (it) it.tags = tags; window.__marked.push(tagPut[1]); return json({ ok: true }); }
                return original(url, opts); }; return true; })()`);
        await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 5`, 'the rows of Needs you', 20000);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            assert.ok((await ev(`fetch('/api/board/${TEAM}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator' }) }).then(r => r.status)`)) < 300);
            await opened();
            const at = `${width} px: `;
            let shown = await ev(names);
            check(shown.length === 5, `${at}Review shows its five oldest rows: ${JSON.stringify(shown)}`);
            check(shown.join() === ['file-01', 'file-02', 'file-03', 'file-04', 'file-05'].join(), `${at}they are the oldest five, oldest first: ${JSON.stringify(shown)}`);
            const more = await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-group-more'); return b ? { text: b.textContent.trim(), expanded: b.getAttribute('aria-expanded') } : null; })()`);
            check(more && more.text === 'Show 3 more' && more.expanded === 'false', `${at}the link says how many are left: ${JSON.stringify(more)}`);
            const readAll = await ev(`(() => { const b = document.querySelector('#group-table-view .inbox-group-read'); return b ? b.textContent.trim() : null; })()`);
            check(readAll === 'Read all 8', `${at}the heading offers Read all for the eight unread ones: ${JSON.stringify(readAll)}`);
            await shot(`inbox-kind-limit-${width}-1`);
            await ev(`document.querySelector('#group-table-view .inbox-group-more').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length >= 8`, `${at}the rest opens`, 8000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({ rows: document.querySelectorAll('#group-table-view tbody tr.dt-row').length, btn: [...document.querySelectorAll('#group-table-view .inbox-group-more')].map(b => b.textContent + '/' + b.getAttribute('aria-expanded')), heads: [...document.querySelectorAll('#group-table-view tr.dt-group')].map(t => t.textContent.slice(0, 40)) })`))); });
            shown = await ev(names); check(shown.length === 8, `${at}Show more opens all eight: ${JSON.stringify(shown)}`);
            check(await ev(`document.querySelector('#group-table-view .inbox-group-more')?.textContent.trim() === 'Show fewer'`), `${at}the link becomes Show fewer`);
            await shot(`inbox-kind-limit-${width}-2`);
            await ev(`document.querySelector('#group-table-view .inbox-group-more').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 5`, `${at}Show fewer shuts them`, 8000);
            // Read all: the unread files are marked read in place; the rows stay
            await ev(`document.querySelector('#group-table-view .inbox-group-read').click(); true`);
            await waitFor(`!document.querySelector('#group-table-view .inbox-group-read')`, `${at}Read all is gone once the group is read`, 15000);
            check(await ev(`document.querySelectorAll('#group-table-view tbody tr.dt-row').length === 5`), `${at}every row is still there after Read all`);
            check((await ev('window.__marked.length')) === 8, `${at}Read all went through the mark-read path for the eight unread files: ${await ev('JSON.stringify(window.__marked)')}`);
            await shot(`inbox-kind-limit-${width}-3`);
        }
    } finally { try { await removeBoards(ev, [TEAM]); } catch (e) {} await guard.restore().catch(() => {}); await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('inbox_kind_limit_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
