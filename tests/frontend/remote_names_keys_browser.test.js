// #13695 (audit #13691, F7 to F9): three small lookups that dropped the computer or the team.
//  F7 (guide_names.js) is not here: the guide role is a Hub grant on a board, so the roster is the Hub's own route (bare_api_fetch_baseline.json says so): a remote team's guides do not exist on the computer.
//  F8 team_names.js teamOf: the person's colour is stored under the team's KEY ('@m1/dev'), so a team on a computer gets its colour (the bare name 'dev' is another team, here).
//  F9 team_availability.js getCachedAgentAvailability: an agent of a team whose state is not cached is not answered from another team's row of the same name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');

        // F8: the colour stored under the team's key
        const colours = await ev(`(async () => { localStorage.setItem('coral-board-colors', JSON.stringify({ '@m1/dev': '#d7263d' }));
            const st = await import(${S} + 'state.js'); const tn = await import(${S} + 'team_names.js');
            st.state.liveSessions = [{ session_id: 'a', board_project: 'dev', server: 'm1' }, { session_id: 'b', board_project: 'dev' }];
            return { remote: tn.teamOf(st.state.liveSessions[0]), local: tn.teamOf(st.state.liveSessions[1]) }; })()`);
        assert.ok(colours.remote && colours.remote.color === '#d7263d', 'F8: the team on m1 has the colour stored under its key: ' + JSON.stringify(colours));
        assert.ok(colours.local && colours.local.color === '', 'F8: the local team named dev has none: ' + JSON.stringify(colours));

        // F9: no answer from another team's row of the same name
        const found = await ev(`(async () => { const real = window.fetch; window.fetch = (u, o) => /\\/api\\/board\\/other\\/status/.test(String(u && u.url || u)) ? Promise.resolve(new Response(JSON.stringify({ summary: { available: 1, busy: 0 }, observed_at: new Date().toISOString(), agents: [{ name: 'Lead', subscriber_id: 'Lead', state: 'idle' }] }), { headers: { 'content-type': 'application/json' } })) : real(u, o);
            try { const a = await import(${S} + 'team_availability.js'); await a.refreshTeamAvailability('other', true);
                return { sameTeam: !!a.getCachedAgentAvailability({ name: 'Lead', board_project: 'other' }), otherTeam: !!a.getCachedAgentAvailability({ name: 'Lead', board_project: 'dev-not-cached' }), noTeam: !!a.getCachedAgentAvailability({ name: 'Lead' }) };
            } finally { window.fetch = real; } })()`);
        assert.equal(found.sameTeam, true, 'F9: its own team\'s row is found: ' + JSON.stringify(found));
        assert.equal(found.otherTeam, false, 'F9: an uncached team\'s agent is not answered from another team\'s Lead: ' + JSON.stringify(found));
        assert.equal(found.noTeam, true, 'F9: an agent with no team known still falls back by name: ' + JSON.stringify(found));
        // F9 (UI Reviewer's SHOULD): a local and a remote team with the SAME bare board name each get their own row, through sessionTeamKey
        const same = await ev(`(async () => { const real = window.fetch; const answer = tag => Promise.resolve(new Response(JSON.stringify({ summary: { available: 1, busy: 0 }, observed_at: new Date().toISOString(), agents: [{ name: 'Lead', subscriber_id: 'Lead', state: tag }] }), { headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u && u.url || u); return /\\/board\\/twin\\/status/.test(url) ? answer(/\\/m1\\//.test(url) ? 'remote-row' : 'local-row') : real(u, o); };
            try { const a = await import(${S} + 'team_availability.js'); await a.refreshTeamAvailability('twin', true); await a.refreshTeamAvailability('@m1/twin', true);
                const st = row => { const r = a.getCachedAgentAvailability(row); return r && r.state; };
                return { local: st({ name: 'Lead', board_project: 'twin' }), remote: st({ name: 'Lead', board_project: 'twin', server: 'm1' }) };
            } finally { window.fetch = real; } })()`);
        assert.deepEqual(same, { local: 'local-row', remote: 'remote-row' }, 'F9: the same board name on this computer and on m1 are two teams, each with its own row: ' + JSON.stringify(same));
        console.log('remote_names_keys_browser: ok');
    } finally { await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
