// #20401 (the Operator): a new version of a file they reviewed does not come back to their Inbox. An agent uploads cut.txt for review, the Operator approves it, the agent uploads a new version with
// --new-version-of and no tag: the file returns to Needs you ONCE, as the new version (the same row, not a duplicate), with a question; the upload's answer says it reached the Inbox; with no_review=1 it
// does not return and the answer says so; and the agent can send the newest version for review without new bytes. No stubs: the runner's isolated server, a stand-in agent with a real session token, the real
// routes, and the real Needs you list on the page.
const assert = require('node:assert/strict');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const { connect } = require('./agent_view_harness');
const { coralReady, waitFor } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');
const { ownRows, settleOwn } = require('./helpers/own_rows');

async function httpJson(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const B = 'nv-' + Date.now().toString(36);
    let standIn = null, client = null, evp = null;
    try {
        const c = await connect(); client = c.client; const { Page, ev, PRELOAD, install } = c; evp = ev;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const person = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))`);
        const needs = async () => { const r = await person('GET', '/api/needs-you'); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; };
        standIn = await launchStandIn(httpJson, { displayName: 'Cut Maker' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const sid = standIn.sid, tok = { 'X-Coral-Session-Token': standIn.token };
        assert.ok((await httpJson('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Cut Maker', job_title: 'Video', session_name: standIn.name })).status < 300);
        const mine = d => ownRows(d.items, { team: B }).filter(i => i.kind === 'review');
        const up = async (text, extra = '', previous = '') => httpJson('POST', `/api/agent/artifacts?session_id=${sid}${extra}`, text, { 'X-Artifact-Name': 'cut.txt', 'X-Artifact-Media-Type': 'text/plain', ...(previous ? { 'X-Artifact-New-Version-Of': previous } : {}), ...tok });
        const stamp = Date.now();

        const v1 = await up(`cut v1 ${stamp}`, '&tag=for+review&question=' + encodeURIComponent('Approve the cut?'));
        assert.ok(v1.status < 300, JSON.stringify(v1));
        assert.equal(v1.data.for_review, true, 'the answer says it reached the Inbox');
        const hex1 = String(v1.data.uri).split('/').pop();
        assert.equal(mine(await needs()).length, 1, 'v1 is waiting');
        assert.equal((await person('POST', `/api/board/${B}/artifacts/${hex1}/review`, { decision: 'approve' })).status, 200);
        assert.equal(await settleOwn(async () => mine(await needs()).length, 0), 0, 'approved: out of Needs you');

        const v2 = await up(`cut v2 ${stamp}`, '', 'coral://artifacts/' + hex1);
        assert.ok(v2.status < 300, JSON.stringify(v2));
        assert.equal(v2.data.for_review, true, 'v2 reached the Inbox: ' + JSON.stringify(v2.data));
        assert.match(String(v2.data.inbox), /Inbox/);
        const hex2 = String(v2.data.uri).split('/').pop();
        assert.equal(await settleOwn(async () => mine(await needs()).length, 1), 1, 'the new version came back, once');
        const row = mine(await needs())[0];
        assert.ok(row.id.includes(hex2), 'the row is the new version: ' + JSON.stringify(row));
        assert.ok(!mine(await needs()).some(i => i.id.includes(hex1)), 'no second row for the approved version');

        // the real list on the page shows one row for the file
        await ev(`window.switchNavTab('hub-inbox'); import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await waitFor(ev, `[...document.querySelectorAll('#group-table-view tbody tr')].filter(r => r.textContent.includes('cut.txt')).length === 1`, 'Needs you shows the file once', { timeout: 15000 });

        // approve v2, then an upload that opts out does not return and says so
        assert.equal((await person('POST', `/api/board/${B}/artifacts/${hex2}/review`, { decision: 'approve' })).status, 200);
        assert.equal(await settleOwn(async () => mine(await needs()).length, 0), 0);
        const v3 = await up(`cut v3 ${stamp}`, '&no_review=1', 'coral://artifacts/' + hex2);
        assert.ok(v3.status < 300, JSON.stringify(v3));
        assert.equal(v3.data.for_review, false, 'the answer says it did not reach the Inbox');
        assert.equal(mine(await needs()).length, 0, 'an upload that opts out stays out');

        // and the newest version goes for review with no new bytes
        const sent = await httpJson('POST', `/api/agent/artifacts/${hex2}/review?session_id=${sid}`, { question: 'Is v3 good?' }, tok);
        assert.equal(sent.status, 200, JSON.stringify(sent));
        assert.equal(sent.data.uri, v3.data.uri, 'the newest version is the one sent');
        assert.equal(await settleOwn(async () => mine(await needs()).length, 1), 1, 'sent without new bytes: back in Needs you');
        assert.equal((await httpJson('POST', `/api/agent/artifacts/${hex2}/review?session_id=${sid}`, {}, tok)).status, 200, 'again: idempotent');
        assert.equal(mine(await needs()).length, 1, 'still one row');
        console.log('inbox_new_version_returns_browser: ok');
    } finally { if (standIn) await standIn.stop().catch(() => {}); if (evp) await removeBoards(evp, [B]).catch(() => {}); if (client) await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
