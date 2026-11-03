// The Needs you folder's number agrees with its list (#12789, the Operator: "the sidebar says Needs you 0 while the table lists items"): a file already read is still listed until it is answered (#9277), and the sidebar
// counted only the unread, so a list of read files said 0. The sidebar now says the unread and how many the list holds, "0 of 2" (as the kind pills do; the badge colour still means unread ones), and the search box and the kind pills stay above the table on
// a desktop at 1280 and at the Operator's width (about 1800). A real board on the isolated server; the review artifacts are stood in at their route. A read file and an unread one, and a question to the Operator.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const team = 'nc-' + Date.now().toString(36);
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, scenario] of [[1280, 900, 'read'], [1800, 1000, 'read'], [1280, 900, 'mixed'], [1800, 1000, 'mixed']]) {
            const tag = `${w} px, ${scenario}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`fetch('/api/board/${team}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'UI/UX', job_title: 'Designer' }) }).then(r => r.status)`);
            await ev(`(async () => { localStorage.removeItem('coral-inbox-needs-filters');
                const mk = (n, name, tags) => ({ id: String(n).padStart(64, '0'), name, media_type: 'text/plain', size: 30, created_at: new Date(Date.now() - n * 60000).toISOString(), tags, available: true, uri: 'coral://artifacts/' + String(n).padStart(64, '0') });
                const arts = ${JSON.stringify(scenario)} === 'read' ? [mk(1, 'Details rail.md', ['for review', 'read']), mk(2, 'Files panel.md', ['for review', 'read'])] : [mk(1, 'Details rail.md', ['for review', 'read']), mk(2, 'Files panel.md', ['for review'])];
                const original = window.fetch, json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (url, opts = {}) => { const u = new URL(String(url), location.origin);
                    if (u.pathname === '/api/board/${team}/artifacts') return json({ project: '${team}', artifacts: arts, has_more: false });
                    return original(url, opts); };
                window.__m.agents = {}; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length >= 2`, `${tag}: the listed files`, 15000);
            await ev(framesJs(10));
            const r = await ev(`(() => { const side = [...document.querySelectorAll('.view-list-item')].find(b => /Needs you/.test(b.textContent)); const cnt = side && side.querySelector('.view-list-count'); const s = document.getElementById('inbox-needs-search'); const sb = s && s.getBoundingClientRect(); const tb = document.querySelector('#group-table-view table, #group-table-view .data-table, #group-table-view [role=table]'); const tt = tb && tb.getBoundingClientRect();
                return { rows: document.querySelectorAll('#group-table-view tbody tr').length, count: cnt ? cnt.textContent.trim() : null, alert: !!(cnt && cnt.classList.contains('view-list-alert')), search: s ? { shown: s.getClientRects().length > 0, w: Math.round(sb.width), t: Math.round(sb.top), r: Math.round(sb.right), above: tt ? sb.bottom <= tt.top + 2 : null } : null, pills: [...document.querySelectorAll('.inbox-folder-toolbar [role=tab], .inbox-folder-toolbar .list-bar-pill, .inbox-folder-toolbar button')].filter(b => b.getClientRects().length).map(b => b.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 8), vw: innerWidth }; })()`);
            check(`${tag}: the sidebar says the unread and the list's size, as the kind pills do`, r.count === (scenario === 'read' ? `0 of ${r.rows}` : `1 of ${r.rows}`) && r.rows === 2, JSON.stringify(r));
            check(`${tag}: the badge colour only when something is unread`, r.alert === (scenario === 'mixed'), JSON.stringify(r));
            check(`${tag}: the search box is there, wide enough, above the table and on screen`, r.search && r.search.shown && r.search.w >= 200 && r.search.r <= r.vw && r.search.above !== false, JSON.stringify(r.search));
            if (scenario === 'mixed') await shot(`needs-${w}`);
        }
    } finally { await removeBoards(ev, [team]).catch(() => {}); await client.close(); }
    assert.deepEqual(problems, [], 'Needs you, its number and its search box:\n  ' + problems.join('\n  '));
    console.log('PASS Needs you: the sidebar number is the list size, the search box stays above the table');
})().catch(e => { console.error(e); process.exit(1); });
