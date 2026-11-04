// The Hub draws Coral's own Needs you table when its boot value says so (#13446, #13450): with `inbox: 'native'` alone Needs you is still the Hub's framed page (an iframe at a constant address); with `needs: 'native'` too the
// folder is Coral's own: no frame, its own search box, its own table. The boot value is the Hub's own page config. The two-computer Hub of helpers/hub_world.js, desktop width.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const open = async () => { await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard'); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const S = `(window.__coralStatic || '/static/')`;
    let needsNow = false, asksStubbed = false;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false, inbox: 'native', needs: () => needsNow, hubPages: true }); // one world; the boot value is read at each load
        for (const needs of [false, true]) {
            needsNow = needs;
            const at = needs ? "needs: 'native': " : "inbox: 'native' alone: ";
            if (needs && !asksStubbed) {
                asksStubbed = true;
                await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const w = window.fetch, ask = (id, text) => ({ board: 'team-a', kind: 'ask', id, asker: 'Writer', text, at: new Date(Date.now() - 120000).toISOString() });
                    window.__asks = [ask(7, 'May I rename the folder?'), ask(8, 'Which port should the test server use?')]; window.__closes = []; window.__closeStatus = 200;
                    window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = (o.method || 'GET').toUpperCase();
                        if (p.pathname === '/api/remote/m1/api/operator-asks') return Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                        const c = p.pathname.match(/^\\/api\\/remote\\/m1\\/api\\/board\\/team-a\\/asks\\/(\\d+)\\/close$/);
                        if (c && m === 'POST') { window.__closes.push({ id: c[1], body: String(o.body || '') }); if (window.__closeStatus === 200) window.__asks = window.__asks.filter(a => String(a.id) !== c[1]); return Promise.resolve(new Response(JSON.stringify(window.__closeStatus === 200 ? { ok: true } : { error: 'owner_only' }), { status: window.__closeStatus, headers: { 'Content-Type': 'application/json' } })); }
                        return w(u, o); }; })()` });
            }
            await open();
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); true`);
            await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
            if (!needs) {
                await waitFor(`!!document.querySelector('#group-table-view iframe')`, at + "Needs you is the Hub's frame", 10000);
                assert.equal(await ev(`document.querySelector('#group-table-view iframe').getAttribute('src')`), '/inbox/hub/needs', at + 'at its constant address');
            } else {
                await waitFor(`document.getElementById('group-table-title') && document.getElementById('group-table-title').textContent === 'Needs you'`, at + "Needs you is Coral's own table", 10000);
                assert.equal(await ev(`!!document.querySelector('#group-table-view iframe')`), false, at + 'no frame');
                assert.equal(await ev(`(() => { const i = document.querySelector('.sidebar-search input'); return !!i && !i.disabled; })()`), true, at + 'its own search box is on');
                // the agents' questions are read by the page itself from each online computer through the Hub (stubbed at page start below), shown as rows; Dismiss posts to the close route the Hub now offers; a refusal is said on the row
                await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(r => /rename the folder/.test(r.textContent))`, at + "the agents' question is a row of the table (read through the Hub)", 15000);
                await ev(`document.querySelector('#group-table-view button[aria-label^="Dismiss the question of"]').click(); true`);
                await waitFor(`window.__closes.length === 1`, at + 'Dismiss posts to the close route', 10000);
                const sent = await ev(`window.__closes[0]`);
                assert.equal(sent.id, '7', at + 'the first question was closed');
                assert.deepEqual(JSON.parse(sent.body), { note: 'Dismissed by the operator' }, at + 'with the fixed note');
                await ev(`window.__closeStatus = 403; true`); // the page read the list again itself after the first close
                await waitFor(`[...document.querySelectorAll('#group-table-view tbody tr')].some(r => /test server/.test(r.textContent))`, at + 'the second question', 10000);
                await ev(`document.querySelector('#group-table-view button[aria-label^="Dismiss the question of"]').click(); true`);
                await waitFor(`/Could not save \\(HTTP 403\\)|owner_only/.test(document.querySelector('#group-table-view .inbox-review-error')?.textContent || '')`, at + 'a refused close is said on the row', 10000);
            }
            console.log(`   ok ${at}`);
        }
        console.log("PASS Needs you is the Hub's frame until the Hub's boot value moves it to Coral's own table");
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
