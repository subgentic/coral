// A suite that makes a message board takes it away again (#4959): the runner's end-check names a board a suite leaves with messages or subscribers, and --fail-on-leak fails the suite for it.
//   const { removeBoards } = require('./helpers/board_cleanup');
//   finally { await removeBoards(ev, [BOARD]); await client.close(); }   // ev(expression): the suite's own page-side evaluate; the page's session is the credential
// DELETE /api/board/{name} removes the board's messages, subscribers, groups, presets and working mode (not its tasks, which the API cannot delete: the end-check does not fail a board that only has tasks).
'use strict';

/** Delete each board by name, through the page, and again a moment later. Never throws: a page that is gone or a board that is already gone is not the suite's failure (the end-check names a board that is still there).
 *  The second pass is for a write that was still in flight when the first ran (a settings toggle's PUT of the board's working mode makes the board's row again, #11000: `board asks-... added (0 messages, 0 tasks, 0 subscribers)` in CI,
 *  never on a fast machine); deleting a board that is gone is harmless. */
const AGAIN_MS = 350;
/** The board's DELETE from Node, with the server's API key (CORAL_TEST_DATA_DIR/api_key, CORAL_TEST_URL: what the runner gives a suite), for a page that is gone: a suite whose CDP socket closed or that was killed at its limit
 *  reaches its finally with no page to ask through, and left its board (the runner then named it, and --fail-on-leak failed it, #15947). Never throws; with no key or address it does nothing. */
async function deleteViaKey(name) {
    try {
        const base = process.env.CORAL_TEST_URL, dir = process.env.CORAL_TEST_DATA_DIR;
        if (!base || !dir) return;
        const key = require('node:fs').readFileSync(require('node:path').join(dir, 'api_key'), 'utf8').trim();
        await fetch(base + '/api/board/' + encodeURIComponent(String(name)), { method: 'DELETE', headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    } catch { /* the end-check reports what is left */ }
}

async function removeBoards(ev, names, via = deleteViaKey) {
    const real = names.filter(Boolean);
    const pass = async () => {
        for (const name of real) {
            try { await ev(`(async () => (await fetch('/api/board/' + encodeURIComponent(${JSON.stringify(String(name))}), { method: 'DELETE' })).status)()`); } catch { await via(name); } // no page to ask through: from Node, with the key
        }
    };
    await pass();
    if (real.length) { await new Promise(r => setTimeout(r, AGAIN_MS)); await pass(); } // sleep-ok: a write in flight lands within a few hundred ms
}

/** Stop and delete each team record by name, through the page (#5343). POST /api/sessions/launch-team makes a team record named after its board (teams and team_members rows) that deleting the board
 *  does not remove: the runner's end-check reported `teams: 0 -> 1 rows` for every suite that launches a team, in every full gate run, and cleaned it up itself. Killing the team's agent one by one leaves
 *  the record "running" (with no active member), and DELETE /api/teams/detail refuses a team that is not stopped, so the team is killed through its own route first (POST /api/sessions/live/team/<board>/kill
 *  stops the record and what is left of its agents). Never throws. */
async function removeTeams(ev, names) {
    for (const name of names) {
        if (!name) continue;
        const n = JSON.stringify(String(name));
        try {
            await ev(`(async () => { await fetch('/api/sessions/live/team/' + encodeURIComponent(${n}) + '/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                return (await fetch('/api/teams/detail/' + encodeURIComponent(${n}), { method: 'DELETE' })).status; })()`);
        } catch { /* the end-check reports what is left */ }
    }
}

/** The live agents now, as {id, name, type}, through the page. A suite that can start agents it did not launch by name (a crawl that clicks, a team that adds members) takes this before it starts and kills the new ones in its finally. Never throws. */
async function liveSessions(ev) {
    try {
        const l = await ev(`fetch('/api/sessions/live').then(r => r.json())`);
        return (Array.isArray(l) ? l : (l && l.sessions) || []).map(x => ({ id: x.session_id, name: x.name || x.session_name || '', type: x.agent_type || 'terminal' }));
    } catch { return []; }
}

/** Kill each agent ({id, name, type}) through the page, so the board it is subscribed to can then be removed without the agent keeping a subscriber on it (#18904: a live agent left `board ... added (1 subscriber)` and a live_sessions row in the end-check). Never throws. */
async function killSessions(ev, sessions) {
    for (const s of sessions) {
        if (!s || !s.id) continue;
        try {
            await ev(`fetch('/api/sessions/live/' + encodeURIComponent(${JSON.stringify(String(s.name || ''))}) + '/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: ${JSON.stringify(s.type || 'terminal')}, session_id: ${JSON.stringify(s.id)} }) }).then(() => true)`);
        } catch { /* the end-check reports what is left */ }
    }
}

module.exports = { removeBoards, removeTeams, liveSessions, killSessions, AGAIN_MS };
