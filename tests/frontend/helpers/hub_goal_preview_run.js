'use strict';
// #13503: through the Coral Hub a goal create, close and update is previewed first when the Hub's boot value goal_preview is true: POST /api/remote/<computer>/api/hub/goal-preview with the exact text of the write, then the write with
// X-Hub-Goal-Preview and the SAME bytes; every write is previewed again; the Hub's words are plain sentences in the editor. With the boot value absent the goal writes go out as today (no preview, no header).
const assert = require('node:assert/strict');
const { connect } = require('../agent_view_harness');
const { setupHubWorld } = require('./hub_world');
const { coralReady } = require('./wait');

const STUB = `(() => {
    window.__computers.forEach((c, i) => c.id = 'srv' + (i + 1));
    const original = window.fetch; window.__goalCalls = []; window.__refuse = null; window.__refusePreview = null;
    const json = (x, status = 200) => Promise.resolve(new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const p = new URL(String(u), location.href).pathname, m = (o.method || 'GET').toUpperCase(), h = o.headers || {};
        const mm = p.match(/^\\/api\\/remote\\/([^/]+)(\\/api\\/.*)$/);
        if (!mm) return original(u, o);
        const path = mm[2];
        if (path === '/api/hub/goal-preview') { window.__goalCalls.push({ kind: 'preview', server: mm[1], body: JSON.parse(o.body) }); if (window.__refusePreview) return json({ error: window.__refusePreview.word }, window.__refusePreview.status); return json({ token: 'TOK' + window.__goalCalls.length, expires: '2099-01-01T00:00:00Z', tier: 'interact', server: mm[1], board: 'team-a' }); }
        if (/^\\/api\\/board\\/team-a\\/goals(\\/\\d+(\\/close)?)?$/.test(path) && m !== 'GET') { window.__goalCalls.push({ kind: 'write', server: mm[1], path, method: m, token: h['X-Hub-Goal-Preview'] || null, body: o.body }); if (window.__refuse) return json({ error: window.__refuse.word }, window.__refuse.status); return json({ id: 5, orchestrator_told_at: null }); }
        if (path === '/api/board/team-a/subscribers') return json([{ subscriber_id: 'dev-1', job_title: 'Dev' }]);
        return json({});
    };
})();`;

async function run(flag) {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        {
            await setupHubWorld({ client, Page, Emulation, width: 1280, height: 900, mobile: false, inbox: 'native', hubPages: true, bootExtra: flag ? '"goal_preview":true' : '' });
            await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired();
            await coralReady(ev, 'startup');
            const calls = () => ev(`window.__goalCalls`);
            const tag = flag ? 'goal_preview true' : 'no goal_preview';

            // a create: the editor, its Create button
            await ev(`window.__created = []; import(${S} + 'goal_editor.js').then(m => { m.openGoalEditor({ project: '@srv1/team-a', onCreated: (p) => { window.__created.push(p); } }); return true; })`);
            await waitFor(`!!document.querySelector('dialog.goal-editor[open] #goal-new-title') && !document.querySelector('#goal-new-driver').disabled`, `${tag}: the editor and its drivers`, 8000);
            await ev(`(() => { const t = document.getElementById('goal-new-title'); t.value = 'Ship the preview'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('dialog.goal-editor form').requestSubmit(); return true; })()`);
            await waitFor(`window.__goalCalls.some(c => c.kind === 'write')`, `${tag}: the create is sent`, 8000);
            let c = await calls();
            if (flag) {
                assert.deepEqual(c.map(x => x.kind), ['preview', 'write'], `${tag}: the preview comes first`);
                assert.equal(c[0].server, 'srv1'); assert.equal(c[0].body.action, 'goal_create'); assert.equal(c[0].body.board, 'team-a'); assert.equal('goal' in c[0].body, false);
                assert.equal(c[1].token, 'TOK1', `${tag}: the write carries the token`); assert.equal(c[1].body, c[0].body.body, `${tag}: the write is the previewed bytes, exactly`);
            } else {
                assert.deepEqual(c.map(x => x.kind), ['write'], `${tag}: no preview without the boot value`); assert.equal(c[0].token, null, `${tag}: no token header`);
            }
            await waitFor(`window.__created.length === 1`, `${tag}: the goal was created`, 5000);

            // a close and a reopen: previewed again, one token each
            await ev(`window.__goalCalls.length = 0; import(${S} + 'goal_write.js').then(async m => { await m.goalWrite('@srv1/team-a', 'goal_close', 5, '/goals/5/close', 'POST', { subscriber_id: 'Operator', state: 'done', reason: 'all done' }); await m.goalWrite('@srv1/team-a', 'goal_update', 5, '/goals/5', 'PATCH', { subscriber_id: 'Operator', state: 'active' }); return true; })`);
            c = await calls();
            if (flag) {
                assert.deepEqual(c.map(x => x.kind), ['preview', 'write', 'preview', 'write'], `${tag}: each write is previewed, once`);
                assert.equal(c[0].body.goal, 5); assert.equal(c[2].body.action, 'goal_update'); assert.notEqual(c[1].token, c[3].token, `${tag}: one token, one write`);
            } else assert.deepEqual(c.map(x => x.kind), ['write', 'write'], `${tag}: the close and the update as always`);

            // the Hub refuses: its word is a sentence in the editor's error line and nothing was created
            if (flag) {
                await ev(`window.__created.length = 0; window.__goalCalls.length = 0; window.__refuse = { word: 'mode_too_low', status: 403 }; import(${S} + 'goal_editor.js').then(m => { m.openGoalEditor({ project: '@srv1/team-a', onCreated: (p) => { window.__created.push(p); } }); return true; })`);
                await waitFor(`document.querySelectorAll('dialog.goal-editor[open]').length === 2 && [...document.querySelectorAll('#goal-new-driver')].every(d => !d.disabled)`, `${tag}: a second editor`, 8000);
                await ev(`(() => { const dlgs = document.querySelectorAll('dialog.goal-editor[open]'), d = dlgs[dlgs.length - 1]; const t = d.querySelector('#goal-new-title'); t.value = 'Second goal'; t.dispatchEvent(new Event('input', { bubbles: true })); d.querySelector('form').requestSubmit(); return true; })()`);
                await waitFor(`/was not created: .*below Interact/.test(document.body.innerText)`, `${tag}: the Hub's refusal is a plain sentence`, 8000);
                assert.equal(await ev(`window.__created.length`), 0, `${tag}: nothing was created`);
            }
        }
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
}
module.exports = { run };
