// The team's Agents tab (Members) on a phone (#11051, the phone smoke of v2.0.4): at 390 px, at 100% and 200% text, no agent's name is cut ("Orch", "Lead", "QA E") and the table does not run off the right edge (the Chat column was cut).
// Real board over the API on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'tmem-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        for (const [id, jt] of [['orch', 'Orchestrator'], ['lead', 'Lead Developer'], ['qa', 'QA Engineer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
        for (const fs of [16, 32]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`document.documentElement.style.fontSize = '${fs}px'; window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`(async () => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (!/\\/api\\/board\\/[^/]+\\/status/.test(String(u)) || !r.ok) return r; const j = await r.clone().json().catch(() => null); if (!j || !Array.isArray(j.agents)) return r; j.agents.forEach(a => { a.availability = 'available'; a.agent_type = 'claude'; }); return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
                const { state } = await import((window.__coralStatic || '/static/') + 'state.js'); state.liveSessions = ['orch', 'lead', 'qa'].map((n, i) => ({ name: n, session_id: 'sid' + i, agent_type: 'claude', board_project: ${JSON.stringify(B)}, display_name: ['Orchestrator', 'Lead Developer', 'QA Engineer'][i] })); return true; })()`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'agents' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-agents .dt-table tbody tr').length >= 3`, `${fs}: the three members`, 15000);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the table settles after its first draw
            const m = await ev(`(() => { const box = document.querySelector('#team-panel-agents .dt-box'), cut = [], rows = [...box.querySelectorAll('tbody tr')];
                for (const tr of rows) { const n = tr.querySelector('td .dt-primary, td button, td a'); const name = tr.querySelector('td[data-key="agent"], td:first-child'); const t = name && name.querySelector('.dt-primary, .dt-name, span:last-child'); if (t && t.scrollWidth > t.clientWidth + 1) cut.push(t.textContent.trim()); }
                const right = [...box.querySelectorAll('td, th')].reduce((x, c) => Math.max(x, c.getBoundingClientRect().right), 0);
                return { cut, boxRight: Math.round(box.getBoundingClientRect().right), cellsRight: Math.round(right), vw: innerWidth, scroll: box.scrollWidth - box.clientWidth, page: document.documentElement.scrollWidth - innerWidth, names: rows.map(r => r.cells[0].textContent.trim()) }; })()`);
            console.log(`   ${fs}: ` + JSON.stringify(m));
            { const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/members-${fs}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); } }
            assert.deepEqual(m.cut, [], `${fs}: no name is cut: ` + JSON.stringify(m));
            { // the Chat cell holds its button whole: no ellipsis beside it, the button inside the cell (the Mobile Beta Tester's stray "…", #11142)
                const c = await ev(`[...document.querySelectorAll('#team-panel-agents tbody tr')].map(tr => { const td = tr.querySelector('td:has(.team-open-chat)'), b = td && td.querySelector('.team-open-chat'); if (!td || !b) return null; const t = td.getBoundingClientRect(), r = b.getBoundingClientRect(); return { cellW: Math.round(t.width), btnW: Math.round(r.width), inside: r.left >= t.left - 0.5 && r.right <= t.right + 0.5, clipped: td.scrollWidth > td.clientWidth + 1, ellipsis: getComputedStyle(td).textOverflow === 'ellipsis' && td.scrollWidth > td.clientWidth }; })`);
                assert.ok(c.length >= 3 && c.every(x => x && x.inside && !x.clipped && !x.ellipsis), `${fs}: the Open chat button is whole inside its cell and nothing is clipped (no stray ellipsis): ` + JSON.stringify(c));
            }
            assert.equal(await ev(`!!document.querySelector('#team-panel-agents thead th[data-key="search"]')`), false, `${fs}: no Search column while every member is at own (an empty one was clipped at the table's edge as a stray "…")`);
            assert.equal(await ev(`[...document.querySelectorAll('#team-panel-agents .team-open-chat')].length`) > 0, true, `${fs}: the Chat column is there`);
            assert.ok(m.cellsRight <= m.boxRight + 1 && m.scroll <= 1 && m.page <= 0, `${fs}: the table fits the screen (no cell past its box, nothing scrolls sideways): ` + JSON.stringify(m));
        }
        console.log('PASS the Members table keeps every name whole and fits a phone at 100% and 200% text');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
