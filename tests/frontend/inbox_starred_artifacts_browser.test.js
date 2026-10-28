// Inbox > Starred lists starred artifacts too (#10258, Beta #10252): the folder showed starred chats only, so a starred artifact was found nowhere obvious. It now has a second part, "Starred artifacts", one row each
// (name, team, when) that opens the preview; the folder's count adds them; with a starred artifact and no starred chat the artifacts stand alone; with nothing starred the empty state says what puts something there.
// GET /api/sessions/history, its counts and GET /api/team-artifacts (starred=true) are stood in. 1280 and 390 px, isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { FOLDER_ROWS } = require('./helpers/folder_rows');

const HEX = 'a'.repeat(64);
const CHAT = { session_id: 'sess-1', source_type: 'claude', agent_name: 'Frontend Dev', display_name: 'Frontend Dev', summary: 'Working on the importer', last_timestamp: '2026-10-25T10:00:00Z', duration_sec: 600, starred: true, archived: false, active: false };
const ART = { id: HEX, name: 'screen.png', media_type: 'image/png', starred: true, created_at: '2026-10-26T09:00:00Z', board_id: 'alpha', team: 'alpha', task_id: 1, task_title: 'Look at it' };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = require('./helpers/scene_shots')(Page, 'inbox-starred');
    const stub = (chats, arts) => ev(`(() => { const R = window.__qaFetch || (window.__qaFetch = window.fetch); window.__starRead = [];
        window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            if (url.pathname === '/api/sessions/history/counts') return json({ all: 1, group: 0, notes: 0, starred: ${chats.length}, active: 0, archived: 0, by_agent_type: { claude: 1 }, tags: [] });
            if (url.pathname === '/api/sessions/history') return json({ sessions: ${JSON.stringify(chats)}, total: ${chats.length}, page: 1, page_size: 50 });
            if (url.pathname === '/api/team-artifacts') { window.__starRead.push(Object.fromEntries(url.searchParams)); return json({ artifacts: ${JSON.stringify(arts)}, teams: [], all: ${arts.length}, total: ${arts.length}, has_more: false }); }
            return R(u, o); }; return true; })()`);
    const openStarred = async mobile => {
        if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'chats-starred'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        else await ev(`document.querySelector('.view-list-item[data-key="chats-starred"]').click(); true`);
        await waitFor(`!!document.querySelector('#group-table-view')`, 'the Starred page', 10000); await settle(500);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const fresh = async (chats, arts) => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.startup('liveList', 'settings')`); await ev('window.__qaFetch = null; true'); await stub(chats, arts);
                await ev(`window.switchNavTab('hub-inbox'); true`); await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000); await openStarred(mobile); };

            console.log(`${label}: a starred chat and a starred artifact`);
            await fresh([CHAT], [ART]);
            await waitFor(`!!document.querySelector('.inbox-starred-artifacts')`, 'the Starred artifacts part', 10000);
            const part = await ev(`(() => { const s = document.querySelector('.inbox-starred-artifacts'); return { head: s.querySelector('h3').textContent, names: [...s.querySelectorAll('button.dt-primary')].map(b => b.textContent.trim()), chats: document.querySelectorAll('#group-table-view button.dt-primary').length }; })()`);
            assert.equal(part.head, 'Starred artifacts'); assert.deepEqual(part.names, ['screen.png'], `${label}: the artifact's row`); assert.ok(part.chats >= 2, `${label}: the starred chat is still listed`);
            assert.equal(await ev(`window.__starRead.some(r => r.starred === 'true')`), true, `${label}: it asks for the starred artifacts`);
            await waitFor(`(() => { const b = document.querySelector('.view-list-item[data-key="chats-starred"]'); return !!b && /2 in all/.test(b.title); })()`, `${label}: the folder's total adds the artifact (its tooltip, "2 in all")`, 8000);
            await shot(`both-${label}`);
            await ev(`document.querySelector('.inbox-starred-artifacts button.dt-primary').click(); true`);
            await waitFor(`!!document.getElementById('artifact-viewer') && getComputedStyle(document.getElementById('artifact-viewer')).display !== 'none'`, 'the preview', 8000);
            await ev(`document.getElementById('artifact-viewer').querySelector('[data-on-click="m-close-artifact-viewer"], .artifact-viewer-close, button')?.click(); true`);

            console.log(`${label}: a starred artifact and no starred chat`);
            await fresh([], [ART]);
            await waitFor(`!!document.querySelector('.inbox-starred-artifacts')`, 'the artifacts alone', 10000);
            assert.equal(await ev(`document.querySelectorAll('#group-table-view .empty-state').length`), 0, `${label}: no "nothing starred" line while something is starred`);

            console.log(`${label}: nothing starred says what puts something there`);
            await fresh([], []);
            await waitFor(`/Nothing starred yet/.test(document.getElementById('group-table-view').textContent)`, 'the empty state', 10000);
            assert.match(await ev(`document.getElementById('group-table-view').textContent`), /Star a chat or an artifact/, `${label}: the hint`);
            assert.equal(await ev(`!!document.querySelector('.inbox-starred-artifacts')`), false, `${label}: no empty artifacts part`);
        }
        console.log('PASS the Starred folder lists starred artifacts');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
