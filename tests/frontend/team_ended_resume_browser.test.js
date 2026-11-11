// Bringing back an ended agent (walk 17 H2 and M5, #15294): the Agents tab's row of an ended agent has a Resume button (it was an empty Chat cell; the way back was All chats, a hover-only Continue),
// named for the agent, that does what Continue this chat > Resume session does (the earlier chat's resume-info, then the launch with resume_session_id and the team); a kill from the sidebar makes the
// open tab read its rows again at once (a killed agent still read Busy). The board's /status, the resume-info and the launch are stubbed. 1280 px, through the real team page.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const TEAM = `qa-resume-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
        await seed(ev, TEAM);
        await ev(`(() => { window.__calls = { status: 0, launch: [] }; window.__back = false; const R = window.fetch.bind(window); window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            if (url.pathname === '/api/board/${TEAM}/status') { window.__calls.status++; const a = (name, availability, reason, extra = {}) => ({ name, subscriber_id: name, agent_type: 'claude', availability, available: availability === 'available', reason, tasks: [], ...extra });
                const lead = window.__back ? a('Lead', 'available', 'Idle') : a('Lead', 'offline', 'Ended. Resume it to bring it back.', { ended_session: { session_id: 'lead-sid', agent_type: 'claude' } });
                return json({ agents: [a('Boss', 'available', 'Idle'), lead, a('Ghost', 'offline', 'Not running')], summary: { total: 3 } }); }
            if (url.pathname === '/api/sessions/history/lead-sid/resume-info') return json({ working_dir: '/tmp/p', working_dir_exists: true, agent_type: 'claude', resume_session_id: 'rs-lead', display_name: 'Lead', permission_mode: 'default' });
            if (url.pathname === '/api/sessions/launch' && o.method === 'POST') { window.__calls.launch.push(JSON.parse(o.body)); window.__back = true; return json({ ok: true }); }
            return R(u, o); }; return true; })()`);
        await openTeam(ev, waitFor, TEAM); await settle(500);
        await ev(`(() => { const t = window.__tp.tabs().find(x => window.__tp.tabLabel(x) === 'Agents'); t.click(); return true; })()`);
        await waitFor(`!!document.querySelector('button[aria-label="Resume Lead"]')`, 'the ended agent has a Resume button', 8000);
        const row = await ev(`(() => { const rows = [...document.querySelectorAll('tr.dt-row')].filter(r => r.getClientRects().length), of = n => rows.find(r => r.innerText.includes(n)); return { lead: [...of('Lead').querySelectorAll('button')].map(b => b.textContent.trim()), ghost: [...of('Ghost').querySelectorAll('button')].map(b => b.textContent.trim()), text: of('Lead').innerText }; })()`);
        assert.ok(row.lead.includes('Resume') && !row.lead.includes('Open chat'), 'the ended row offers Resume: ' + JSON.stringify(row));
        assert.ok(!row.ghost.includes('Resume'), 'a member with no session of its own has nothing to resume: ' + JSON.stringify(row));
        assert.doesNotMatch(row.text, /registered local session/i, 'no jargon in the row: ' + row.text);
        const before = await ev('window.__calls.status');
        await ev(`window.dispatchEvent(new Event('kill')); true`);
        await waitFor(`window.__calls.status > ${before}`, 'a kill makes the open tab read its rows again', 5000);
        await ev(`document.querySelector('button[aria-label="Resume Lead"]').click(); true`);
        await waitFor(`window.__calls.launch.length === 1`, 'Resume starts the agent from its earlier chat', 8000);
        const l = await ev('window.__calls.launch[0]');
        assert.equal(l.resume_session_id, 'rs-lead', 'from its own chat: ' + JSON.stringify(l));
        assert.equal(l.display_name, 'Lead'); assert.equal(l.board_name, TEAM, 'back in the team: ' + JSON.stringify(l));
        await waitFor(`!document.querySelector('button[aria-label="Resume Lead"]')`, 'the row reads again and the Resume button is gone', 8000);
        console.log('PASS the ended agent\'s row has Resume, it resumes the earlier chat in the team, and a kill refreshes the tab');
    } finally { await removeBoards(ev, [TEAM]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
