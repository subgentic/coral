// A running agent's chat opened from Inbox > Chats opens the agent itself, with its message box (#12654, coral-hub's beta pass of the Hub): the list opened every chat in the history view, a transcript with no box, while the
// same agent opened from Agents had one. A chat of an agent this computer has running now goes to the live chat (as a saved message of a live agent already does); an ended agent's chat stays in the history view.
// At 1280 and 390 px; GET /api/sessions/history is stood in; the running agent is one live session of the page's own list.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const ROWS = [
    { session_id: 'aaaaaaaa-0000-4000-8000-000000000001', source_type: 'claude', agent_name: 'Running Dev', display_name: 'Running Dev', summary: 'Still at it', last_timestamp: '2026-10-25T10:00:00Z', duration_sec: 600, starred: false, archived: false, active: true, tags: [] },
    { session_id: 'aaaaaaaa-0000-4000-8000-000000000002', source_type: 'claude', agent_name: 'Ended Dev', display_name: 'Ended Dev', summary: 'Finished long ago', last_timestamp: '2026-10-24T10:00:00Z', duration_sec: 900, starred: false, archived: false, active: false, tags: [] },
];
const COUNTS = { all: 2, group: 0, notes: 0, starred: 0, active: 1, archived: 0, by_agent_type: { claude: 2 }, tags: [] };

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const which of ['running', 'ended']) {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
                await ev(`(async () => { const { state } = await import(${S} + 'state.js'); state.liveSessions = [{ name: 'Running Dev', session_id: ${JSON.stringify(ROWS[0].session_id)}, agent_type: 'claude', server: 'local', status: 'idle', display_name: 'Running Dev', working_directory: '/repo/run', archived: false }];
                    const R = window.fetch; window.fetch = (u, o) => { const url = new URL(String(u), location.href), json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                        if (url.pathname === '/api/sessions/history/counts') return json(${JSON.stringify(COUNTS)});
                        if (url.pathname === '/api/sessions/history') return json({ sessions: ${JSON.stringify(ROWS)}, total: 2, page: 1, page_size: 50 });
                        return R(u, o); }; return true; })()`);
                await ev(`window.switchNavTab('hub-inbox'); true`);
                await waitFor(`document.querySelectorAll('.view-list-item').length > 3 || !!document.querySelector('.view-list select')`, 'the folders', 10000);
                await waitFor(`!!document.querySelector('.view-list-item[data-key="chats"]') || !!document.querySelector('.view-list select')`, 'the Chats folder', 10000);
                if (mobile) await ev(`(() => { const s = document.querySelector('.view-list select'); s.value = 'chats'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`document.querySelector('.view-list-item[data-key="chats"]').click(); true`);
                await waitFor(`document.querySelectorAll('button.dt-primary, button.dt-person').length >= 2`, 'the two chats', 10000);
                const name = which === 'running' ? 'Running Dev' : 'Ended Dev';
                await ev(`(() => { const row = [...document.querySelectorAll('#group-table-view tbody tr')].find(t => t.textContent.includes(${JSON.stringify(name)})); if (!row) throw new Error('no row for ' + ${JSON.stringify(name)} + ': ' + [...document.querySelectorAll('#group-table-view tbody tr')].map(t => t.textContent.slice(0, 40)).join(' | ')); (row.querySelector('button.dt-primary, button.dt-person') || row).click(); return true; })()`);
                await waitFor(`(async () => { const { state } = await import(${S} + 'state.js'); return !!state.currentSession && ['live', 'history'].includes(state.currentSession.type); })()`, 'a chat opened', 10000).catch(() => {});
                await waitFor(`document.body.getAttribute('data-nav-tab') !== 'hub-inbox' || !!document.getElementById('history-session-view') && document.getElementById('history-session-view').getClientRects().length > 0`, 'the chat on screen', 10000);
                const r = await ev(`(async () => { const { state } = await import(${S} + 'state.js'); const box = document.getElementById('command-input'); return { type: state.currentSession && state.currentSession.type, name: state.currentSession && state.currentSession.name, tab: document.body.getAttribute('data-nav-tab'), box: !!(box && box.getClientRects().length) }; })()`);
                if (which === 'running') {
                    assert.equal(r.type, 'live', at + 'a running agent\'s chat opens the agent, not its history: ' + JSON.stringify(r));
                    assert.equal(r.name, 'Running Dev', at + 'the agent it names: ' + JSON.stringify(r));
                    assert.equal(r.box, true, at + 'with its message box: ' + JSON.stringify(r));
                } else {
                    assert.equal(r.type, 'history', at + 'an ended agent\'s chat stays in the history view: ' + JSON.stringify(r));
                }
            }
            console.log(`   ✓ ${w} px`);
        }
        console.log('PASS Inbox > Chats opens a running agent live and an ended one in history');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
