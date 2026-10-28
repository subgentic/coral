// An ended agent is not one that needs a person (UI/UX's decision of #8269, built in #8271): the team page's "N need attention" counts only the agents waiting for input (not a queued one: it waits for a slot), the Agents tab names an agent with no
// live terminal "Ended" (row and chip) and says why its count differs from the sidebar's: "4 agents, 2 ended". The board's /status answer is stubbed with a free, a waiting, a queued and two ended agents. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-ended-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await seed(ev, TEAM);
            await ev(`(() => { const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/board/${TEAM}/status') { const a = (name, availability, reason) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: [] });
                    const agents = [a('Free One', 'available', 'Idle'), a('Asker', 'needs_input', 'Waiting for user input or approval'), a('Gone One', 'offline', 'No live terminal session'), a('Gone Two', 'offline', 'No live terminal session'), a('Queued One', 'queued', 'Has ready assigned work')];
                    return Promise.resolve(new Response(JSON.stringify({ agents, summary: { total: 5, available: 1, needs_input: 1, offline: 2, queued: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM); await settle(600);
            const head = await ev(`(document.getElementById('team-page-status') || {}).textContent`);
            assert.match(head, /^1 needs attention$/, `${tag}: the two ended agents and the queued one are not counted: ` + head);
            await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
            await waitFor(`[...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length).length === 5`, 'the five agents', 8000);
            const r = await ev(`(() => ({ line: (document.querySelector('.team-agents-count') || {}).textContent, chips: [...document.querySelectorAll('.goals-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim()), gone: [...document.querySelectorAll('tr.dt-row')].filter(x => /Gone One/.test(x.innerText)).map(x => x.innerText.replace(/\\s+/g, ' '))[0], remind: Object.fromEntries([...document.querySelectorAll('tr.dt-row')].map(x => [x.innerText.replace(/\\s+/g, ' ').trim().split(' ')[1] || x.innerText.slice(0, 8), !![...x.querySelectorAll('button')].find(b => /Open chat/.test(b.textContent))])), gap: Math.round((document.querySelector('.dt-box') || document.querySelector('table')).getBoundingClientRect().top - document.querySelector('.team-agents-count').getBoundingClientRect().bottom) }))()`);
            assert.ok(r.remind && Object.entries(r.remind).filter(([n]) => /Gone/.test(n)).every(([, has]) => !has) , `${tag}: Open chat is not shown for an ended agent: ` + JSON.stringify(r.remind));
            assert.equal(r.line, '5 agents, 2 ended', `${tag}: the count line says why the numbers differ: ` + r.line);
            assert.ok(r.chips.some(c => /^Ended\b.*2/.test(c)) && !r.chips.some(c => /Offline/.test(c)), `${tag}: the filter chip is Ended 2: ` + JSON.stringify(r.chips));
            const chipClass = await ev(`(() => { const c = n => { const row = [...document.querySelectorAll('tr.dt-row')].find(x => x.innerText.includes(n)); const chip = row && row.querySelector('.dt-chip'); return chip ? chip.className : ''; }; return { queued: c('Queued One'), asker: c('Asker'), ended: c('Gone One') }; })()`);
            assert.ok(/goal-state-blocked/.test(chipClass.asker) && !/goal-state-blocked/.test(chipClass.queued) && chipClass.queued === chipClass.ended, `${tag}: amber is for the agent that needs input; Queued is the quiet chip like Ended: ` + JSON.stringify(chipClass));
            if (process.env.SHOT_DIR) require('node:fs').writeFileSync(`${process.env.SHOT_DIR}/ended-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); // a picture for a review, when asked for
            // where the Status column has given way (a phone) the state is the dot by the name, which a screen reader reads as Ended (the one-line row, #9713)
            const dotName = await ev(`(() => { const row = [...document.querySelectorAll('tr.dt-row')].find(x => /Gone One/.test(x.innerText)); const d = row && row.querySelector('.team-agent-dot'); return d ? d.getAttribute('aria-label') : ''; })()`);
            assert.match(r.gone + ' ' + dotName, /Ended/, `${tag}: an ended agent's status says Ended (its text or its dot's name): ` + r.gone + ' / ' + dotName);
            console.log(`PASS ${tag}: ended agents are not "need attention", are named Ended, and the tab counts them in words`);
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
