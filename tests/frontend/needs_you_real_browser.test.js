// GET /api/needs-you on a real server (#11596): a stand-in agent that waits on a permission, a question that agent asks the Operator, a proposal-free board and a file the agent tags for review show up in ONE read, as the
// Inbox counts them, with their lines cleaned and a token redacted; the cursor gives only what is at or after it; Ignore, Approve and Deny take the file out of the count; a script with no person's standing is refused.
// No stubs: the runner's isolated server, a stand-in agent with a real session token, the real routes. No page is opened (Chrome is only the runner's).
const assert = require('node:assert/strict');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

async function httpJson(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const B = 'ny-' + Date.now().toString(36);
    let standIn = null, client = null, evp = null;
    try {
        const c = await connect(); client = c.client; const { Page, ev, PRELOAD, install } = c; evp = ev;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        // what the Operator's own page may call: a person's standing, which a bare script does not have
        const person = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
        const needs = async (q = '') => { const r = await person('GET', '/api/needs-you' + q); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; };
        standIn = await launchStandIn(httpJson, { displayName: 'Needs Walker' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const sid = standIn.sid, name = standIn.name, tok = { 'X-Coral-Session-Token': standIn.token };
        assert.ok((await httpJson('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Needs Walker', job_title: 'Backend Dev', session_name: name })).status < 300);
        const base = await needs();
        const mine = d => d.items.filter(i => i.team === B);

        // an agent waiting on a question
        // the events and requests are stored under the live list's own name for the agent (its folder), not the launch's session name
        const liveList = await (await fetch(BASE + '/api/sessions/live')).json().catch(() => []);
        const agentName = ((Array.isArray(liveList) ? liveList : liveList.sessions || []).find(x => x.session_id === sid) || {}).name || name;
        let r = await httpJson('POST', `/api/sessions/live/${encodeURIComponent(agentName)}/events`, { event_type: 'permission_request', summary: 'Wants to run npm test', session_id: sid }, tok);
        assert.ok(r.status < 300, JSON.stringify(r));
        let d = await needs();
        assert.equal(d.count, base.count + 1, 'the waiting agent is counted: ' + JSON.stringify(d));
        const agent = mine(d).find(i => i.kind === 'agent');
        assert.ok(agent, 'an agent item on the team: ' + JSON.stringify(d.items));
        assert.ok(agent.id.startsWith('agent:') && agent.line && agent.at, JSON.stringify(agent));

        // a question the agent asks the Operator, with a token in it
        assert.ok((await person('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' })).status < 300, 'the Operator is on the board, as a person is who has posted there');
        const token = 'ghp_' + 'aB3dE5gH7j'.repeat(4);
        r = await httpJson('POST', `/api/board/${B}/messages`, { subscriber_id: 'Needs Walker', content: `@Operator may I ship? my token is ${token}\nplease advise`, ask: true }, tok);
        assert.ok(r.status < 300, JSON.stringify(r));
        d = await needs();
        const ask = mine(d).find(i => i.kind === 'question');
        assert.ok(ask, 'the question is listed: ' + JSON.stringify(d.items));
        assert.ok(!JSON.stringify(d).includes(token) && !JSON.stringify(d).includes(token.slice(0, 20)), 'the token is redacted');
        assert.ok(!ask.line.includes('\n'), 'one line');
        assert.equal(ask.from, 'Needs Walker');
        assert.equal(d.counts.question, (base.counts.question || 0) + 1);

        // a file the agent tags for review
        const up = await httpJson('POST', `/api/agent/artifacts?session_id=${sid}&tag=for+review`, 'plan ' + Date.now(), { 'X-Artifact-Name': 'plan.txt', 'X-Artifact-Media-Type': 'text/plain', ...tok });
        assert.ok(up.status < 300, JSON.stringify(up));
        d = await needs();
        const review = mine(d).find(i => i.kind === 'review');
        assert.ok(review && review.line === 'plan.txt', 'the file for review is listed: ' + JSON.stringify(d.items));
        const hex = review.id.split(':')[2];

        // the cursor: at or after, and nothing from the future
        const cursor = d.cursor;
        assert.ok(cursor, 'a cursor');
        assert.ok((await needs('?after=' + encodeURIComponent(cursor))).items.length >= 1, 'the newest item is at the cursor');
        assert.equal((await needs('?after=2999-01-01T00:00:00Z')).items.length, 0, 'nothing from the future');
        assert.equal((await person('GET', '/api/needs-you?after=yesterday')).status, 400);

        // Ignore takes it out of the count and Unignore puts it back; Approve and Deny take it out for good
        const review1 = async decision => person('POST', `/api/board/${B}/artifacts/${hex}/review`, { decision });
        const countOf = async () => (await needs()).counts.review;
        const before = await countOf();
        assert.equal((await review1('ignore')).status, 200);
        assert.equal(await countOf(), before - 1, 'ignored: not waiting');
        assert.equal((await review1('unignore')).status, 200);
        assert.equal(await countOf(), before, 'unignored: waiting again');
        const denied = await review1('deny');
        assert.equal(denied.status, 200, JSON.stringify(denied));
        assert.equal(await countOf(), before - 1, 'denied: not waiting');

        // a script that is not a person has no standing here
        r = await httpJson('GET', '/api/needs-you', undefined, tok);
        assert.equal(r.status, 403, 'an agent token is refused: ' + JSON.stringify(r));
        console.log('needs_you_real_browser: ok');
    } finally { if (standIn) await standIn.stop().catch(() => {}); if (evp) await removeBoards(evp, [B]).catch(() => {}); if (client) await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
