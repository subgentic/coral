// With two or more teams, a chat row and a notice that name an agent name its team too (#10134, Beta #10130): two Orchestrators in All chats were the same word twice. One team: nothing changes.
//  - Inbox > All chats gets a Team column (the team's name, with its colour when the person gave it one) only while two or more teams exist; a chat of an agent that is no longer on the list has no team to name.
//  - The needs-input toast and the desktop alert say "Orchestrator (team-a)".
// 1280 and 390 px; isolated dev server over CDP; the chat list is a stub, the agents are the harness's mocked live list.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`localStorage.setItem('coral-board-colors', JSON.stringify({ 'team-a': '#d7263d' })); true`);
            await ev(`(() => { const real = window.fetch; const json = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                const at = hh => { const d = new Date(); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
                window.__rows = [ { session_id: 'oa-id', title: 'Plan the release', source_type: 'claude', display_name: 'Orchestrator', last_timestamp: at(14) },
                    { session_id: 'ob-id', title: 'Plan the release', source_type: 'claude', display_name: 'Orchestrator', last_timestamp: at(13) },
                    { session_id: 'gone-id', title: 'An old chat', source_type: 'claude', display_name: 'Retired', last_timestamp: at(12) } ];
                window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname; if (p === '/api/sessions/history') return json({ sessions: window.__rows, total: window.__rows.length, page: 1, page_size: 50 }); if (p === '/api/sessions/history/counts') return json({ all: 3, group: 0, notes: 0, active: 0, starred: 0, archived: 0, by_agent_type: {}, tags: [] }); return real(u, o); };
                window.__m.add('Orchestrator', 'A', 2, { sleeping: false, board_project: 'team-a', session_id: 'oa-id' });
                window.__m.add('Orchestrator B', 'B', 2, { sleeping: false, board_project: 'team-b', session_id: 'ob-id', display_name: 'Orchestrator' });
                window.T.render.renderLiveSessions(window.T.state.liveSessions); return true; })()`);
            await sleep(500); // sleep-ok: the live list draws
            await ev(`Promise.all([import(${S} + 'nav.js')]).then(([n]) => n.go({ view: 'inbox-folder', folder: 'chats' })).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr, #group-table-view .mail-row').length >= 3`, 'the three chats', 12000);
            await sleep(500); // sleep-ok: the rows settle
            const rows = await ev(`(() => { const heads = [...document.querySelectorAll('#group-table-view thead th')].map(h => h.textContent.trim()); const trs = [...document.querySelectorAll('#group-table-view tbody tr')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()).filter(t => !/^Today/.test(t)); const dots = [...document.querySelectorAll('#group-table-view .dt-team-dot')].map(d => getComputedStyle(d).getPropertyValue('--team-accent').trim() || d.style.getPropertyValue('--team-accent')); return { heads, trs, dots, text: document.getElementById('group-table-view').innerText.replace(/\\s+/g, ' ') }; })()`);
            if (!mobile) {
                check(`${tag}: with two teams the chats table has a Team column`, rows.heads.includes('Team'), JSON.stringify(rows.heads));
                check(`${tag}: each Orchestrator says its team, and a chat whose agent is gone says none`, /Orchestrator.*team-a/.test(rows.trs[0] || '') && /Orchestrator.*team-b/.test(rows.trs[1] || '') && !/team-/.test(rows.trs[2] || ''), JSON.stringify(rows.trs));
                check(`${tag}: team-a's colour (the person's) is on its dot, team-b has none`, rows.dots.length >= 2 && /d7263d/i.test(rows.dots[0] || '') && !/[0-9a-f]{6}/i.test(rows.dots[1] || ''), JSON.stringify(rows.dots));
            } else check(`${tag}: a phone's rows lead the chat's line with its team (the agent's name keeps its room)`, /Orchestrator team-a \u00b7 Plan the release/.test(rows.text) && /Orchestrator team-b \u00b7 Plan the release/.test(rows.text) && !/Retired team-/.test(rows.text), rows.text.slice(0, 300));
            await shot(`inbox-team-names-${w}`);
            // the notices
            const said = await ev(`import(${S} + 'team_names.js').then(m => { const live = window.T.state.liveSessions; const a = live.find(x => x.session_id === 'oa-id'); return { many: m.manyTeams(), label: m.withTeam('Orchestrator', a) }; })`);
            check(`${tag}: a notice that names the agent says "Orchestrator (team-a)"`, said.many === true && said.label === 'Orchestrator (team-a)', JSON.stringify(said));
            // one team: nothing changes
            await ev(`window.__m.agents['ob-id'] && delete window.__m.agents['ob-id']; window.T.state.liveSessions = window.T.state.liveSessions.filter(x => x.session_id !== 'ob-id'); window.T.render.renderLiveSessions(window.T.state.liveSessions); import(${S} + 'nav.js').then(n => n.go({ view: 'inbox-folder', folder: 'chats-notes' })).then(() => n2 = 1).catch(() => 0); true`);
            await sleep(300); // sleep-ok: the list draws again
            const one = await ev(`import(${S} + 'team_names.js').then(m => ({ many: m.manyTeams(), label: m.withTeam('Orchestrator', window.T.state.liveSessions.find(x => x.session_id === 'oa-id')) }))`);
            check(`${tag}: with one team a notice names the agent alone`, one.many === false && one.label === 'Orchestrator', JSON.stringify(one));
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} team name checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
