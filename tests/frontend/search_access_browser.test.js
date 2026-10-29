// The Search access control (#11053, goal #154, the levels of #11048): a chip on the Agents tab row and the agent page only above "own"; the agent page's "Search access…" opens a dialog with the four levels (own checked); a lower level saves with {level};
// the top level asks again in the same dialog with the focus on Back, and saves {level, confirm: "operator"}; the Hub's dialog is read-only and says where to change it. 1280, and 390 px at 200% text. GET /api/teams/detail/<team> and the PUT are stood in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tsa-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status }))`);
    const STUB = `(() => { const real = window.fetch; window.__puts = []; window.__levels = { orch: 'own', lead: 'team', qa: 'operator' };
        const json = (o, status) => Promise.resolve(new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
            if (method === 'GET' && /\\/api\\/teams\\/detail\\/[^/?]+$/.test(url)) return json({ name: ${JSON.stringify(B)}, members: Object.keys(window.__levels).map((n, i) => ({ id: 10 + i, agent_name: n, search_reach: window.__levels[n] })) });
            const m = url.match(/\\/api\\/team-members\\/(\\d+)\\/search-access$/);
            if (method === 'PUT' && m) { const b = JSON.parse(o.body); window.__puts.push({ id: Number(m[1]), ...b }); if (b.level === 'operator' && b.confirm !== 'operator') return json({ error: 'confirm', code: 'confirm_required' }, 400);
                window.__levels[['orch', 'lead', 'qa'][Number(m[1]) - 10]] = b.level; return json({ ok: true, member_id: Number(m[1]), level: b.level }); }
            return real(u, o); }; return true; })()`;
    const dlg = js => ev(`(() => { const d = document.getElementById('search-access-dialog'); return d && d.open ? (${js}) : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, mobile, fs] of [[1280, false, 16], [390, true, 32]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            if (w === 1280) for (const [id, jt] of [['orch', 'Orchestrator'], ['lead', 'Lead'], ['qa', 'QA']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'agents' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-agents .dt-table tbody tr').length >= 3`, `${w}: the members`, 15000);
            await waitFor(`/Search: team/.test(document.querySelector('#team-panel-agents').textContent)`, `${w}: the chips`, 6000);
            const text = await ev(`document.querySelector('#team-panel-agents').textContent`);
            if (w === 1280) {
                assert.ok(/Search: all \+ operator history/.test(text), `${w}: the top level has a chip`);
                assert.equal(await ev(`[...document.querySelectorAll('#team-panel-agents tbody tr')].filter(r => /Search:/.test(r.textContent)).length`), 2, `${w}: a chip on the two rows above own, none on "own"`);
            }
            await ev(`[...document.querySelectorAll('#team-panel-agents tbody tr .dt-primary')].find(b => /orch/.test(b.textContent)).click(); true`);
            await waitFor(`!!document.querySelector('.team-agent-page')`, `${w}: the agent page`, 6000);
            assert.ok(!/Search:/.test(await ev(`document.querySelector('.team-agent-page').textContent`)), `${w}: no chip at own`);
            await ev(`[...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Search access/.test(b.textContent)).click(); true`);
            await waitFor(`document.getElementById('search-access-dialog')?.open`, `${w}: the dialog`, 4000);
            const radios = await dlg(`[...d.querySelectorAll('input[type=radio]')].map(r => r.value + (r.checked ? '*' : ''))`);
            assert.deepEqual(radios, ['own*', 'team', 'all', 'operator'], `${w}: the four levels, own checked`);
            assert.ok(await dlg(`/also your own boards and your own Claude\\/Codex conversations on this computer/.test(d.textContent)`), `${w}: the top level's line`);
            assert.ok(await dlg(`/cloned or imported member starts at "own"/.test(d.textContent)`), `${w}: the dialog says a clone or import starts at own`);
            const fits = await dlg(`(() => { const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth + 1; })()`);
            assert.ok(fits, `${w}: the dialog fits the screen`);
            { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/search-access-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
            await ev(`document.querySelector('#search-access-dialog input[value=team]').click(); [...document.querySelectorAll('#search-access-dialog .modal-footer .btn-primary')][0].click(); true`);
            await waitFor(`!document.getElementById('search-access-dialog').open`, `${w}: Save closes it`, 4000);
            assert.deepEqual(await ev(`window.__puts.slice(-1)[0]`), { id: 10, level: 'team' }, `${w}: a lower level saves {level} alone`);
            await ev(`[...document.querySelectorAll('.team-agent-page .goals-pinbar button')].find(b => /Search access/.test(b.textContent)).click(); true`);
            await waitFor(`document.getElementById('search-access-dialog')?.open`, `${w}: the dialog again`, 4000);
            await ev(`document.querySelector('#search-access-dialog input[value=operator]').click(); true`);
            assert.equal(await dlg(`d.querySelector('.modal-footer .btn-primary').textContent`), 'Continue', `${w}: the top level says Continue, not Save`);
            await ev(`document.querySelector('#search-access-dialog .modal-footer .btn-primary').click(); true`);
            await waitFor(`/search your chat history/.test(document.getElementById('search-access-title')?.textContent || '')`, `${w}: the second step`, 4000);
            assert.equal(await ev(`document.activeElement.textContent`), 'Back', `${w}: the focus starts on Back`);
            assert.equal(await ev(`window.__puts.length`), 1, `${w}: nothing is saved before the second step is answered`);
            await ev(`[...document.querySelectorAll('#search-access-dialog button')].find(b => b.textContent === 'Back').click(); true`);
            assert.equal(await dlg(`d.querySelectorAll('input[type=radio]').length`), 4, `${w}: Back returns to the levels`);
            await ev(`document.querySelector('#search-access-dialog input[value=operator]').click(); document.querySelector('#search-access-dialog .modal-footer .btn-primary').click(); true`);
            await ev(`[...document.querySelectorAll('#search-access-dialog button')].find(b => b.textContent === 'Allow all history').click(); true`);
            await waitFor(`!document.getElementById('search-access-dialog').open`, `${w}: Allow closes it`, 4000);
            assert.deepEqual(await ev(`window.__puts.slice(-1)[0]`), { id: 10, level: 'operator', confirm: 'operator' }, `${w}: the top level saves with confirm`);
            // the Hub's dialog: read-only
            await ev(`import((window.__coralStatic || '/static/') + 'search_access.js').then(m => m.openSearchAccess({ name: 'orch', id: 10, level: 'team' }, { readOnly: true })); true`);
            await waitFor(`document.getElementById('search-access-dialog')?.open`, `${w}: the Hub's dialog`, 4000);
            assert.ok(await dlg(`/Change this on the machine's own dashboard\\./.test(d.textContent) && d.querySelectorAll('input[type=radio]').length === 0 && !d.querySelector('.btn-primary')`), `${w}: on the Hub the level is shown, with no radios and no Save`);
            await ev(`document.getElementById('search-access-dialog').close(); true`);
            console.log(`   ${w}: ok`);
        }
        console.log('PASS the Search access control');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
