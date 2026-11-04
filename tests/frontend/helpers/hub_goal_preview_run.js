'use strict';
// #13503: through the Coral Hub a goal create, close and update is previewed first when the Hub's boot value goal_preview is true: POST /api/remote/<computer>/api/hub/goal-preview with the exact text of the write, then the write with
// X-Hub-Goal-Preview and the SAME bytes; every write is previewed again; the Hub's words are plain sentences in the editor. With the boot value absent the goal writes go out as today (no preview, no header).
const assert = require('node:assert/strict');
const { connect } = require('../agent_view_harness');
const { setupHubWorld, BASE } = require('./hub_world');
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
        if (path === '/api/hub/goal-preview') { window.__goalCalls.push({ kind: 'preview', server: mm[1], body: JSON.parse(o.body) }); if (window.__refusePreview) return json({ error: window.__refusePreview.word }, window.__refusePreview.status); if (window.__limitAt && window.__goalCalls.filter(c => c.kind === 'preview').length >= window.__limitAt) return json({ error: 'too_many_requests' }, 429); return json({ token: 'TOK' + window.__goalCalls.length, expires: '2099-01-01T00:00:00Z', tier: 'interact', server: mm[1], board: 'team-a' }); }
        if (/^\\/api\\/board\\/team-a\\/goals(\\/\\d+(\\/close)?)?$/.test(path) && m !== 'GET') { window.__goalCalls.push({ kind: 'write', server: mm[1], path, method: m, token: (h instanceof Headers ? h.get('X-Hub-Goal-Preview') : (h['X-Hub-Goal-Preview'] || h['x-hub-goal-preview'])) || null, body: o.body }); if (window.__refuse) return json({ error: window.__refuse.word }, window.__refuse.status); return json({ id: 5, orchestrator_told_at: null }); }
        if (path === '/api/board/team-a/subscribers') return json([{ subscriber_id: 'dev-1', job_title: 'Dev' }]);
        if (m === 'GET' && /^\\/api\\/board\\/team-a\\/goals($|\\?)/.test(path + new URL(String(u), location.href).search)) return json({ goals: [1, 2, 3].map(i => ({ id: i, title: 'Goal ' + i, state: 'active', outcome: 'o', done_when: 'd', rollup: { open: 0, done: 0, total: 0 } })), has_more: false });
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
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            const calls = () => ev(`window.__goalCalls`);
            const tag = flag ? 'goal_preview true' : 'no goal_preview';

            // #13515: served by a Hub, a goal page offers no Change driver and no Move to another team (the tunnel does not list them: the dialogs said not found); Close goal is still there
            await ev(`import(${S} + 'goal_view.js').then(async v => { const a = await import(${S} + 'goals_adapter.js'); const host = document.createElement('div'); host.id = 'gp-nodrv'; document.body.appendChild(host); v.mountGoal(host, { team: 'team-a', id: 9, goal: a.toGoal({ id: 9, title: 'No driver here', state: 'active', outcome: 'o', done_when: 'd', rollup: { open: 0, done: 0, total: 0 } }), back() {}, refresh() {} }); return true; })`);
            await waitFor(`!!document.querySelector('#gp-nodrv .goals-close')`, `${tag}: a goal page opens`, 8000);
            assert.deepEqual(await ev(`({ driver: !!document.querySelector('#gp-nodrv .goals-change-driver'), move: !!document.querySelector('#gp-nodrv .goals-move') })`), { driver: false, move: false }, `${tag}: no Change driver and no Move through a Hub`);
            await ev(`document.getElementById('gp-nodrv').remove(); true`);

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
                await waitFor(`document.querySelectorAll('dialog.goal-editor[open]').length >= 1 && [...document.querySelectorAll('dialog.goal-editor[open] #goal-new-driver')].every(d => !d.disabled)`, `${tag}: another editor`, 8000);
                await ev(`(() => { const dlgs = document.querySelectorAll('dialog.goal-editor[open]'), d = dlgs[dlgs.length - 1]; const t = d.querySelector('#goal-new-title'); t.value = 'Second goal'; t.dispatchEvent(new Event('input', { bubbles: true })); d.querySelector('form').requestSubmit(); return true; })()`);
                await waitFor(`/was not created: .*below Interact/.test(document.body.innerText)`, `${tag}: the Hub's refusal is a plain sentence`, 8000);
                assert.equal(await ev(`window.__created.length`), 0, `${tag}: nothing was created`);
                await ev(`window.__refuse = null; document.querySelectorAll('dialog.goal-editor[open]').forEach(d => d.close()); true`);

                // the goal page's Close dialog, through the UI: previewed, then written with the token and the dialog's own body
                await ev(`window.__goalCalls.length = 0; import(${S} + 'goal_view.js').then(async v => { const a = await import(${S} + 'goals_adapter.js'); const host = document.createElement('div'); host.id = 'gp-host'; document.body.appendChild(host); v.mountGoal(host, { team: '@srv1/team-a', id: 5, goal: a.toGoal({ id: 5, title: 'Close me', state: 'active', outcome: 'o', done_when: 'd', rollup: { open: 0, done: 0, total: 0 } }), back() {}, refresh() {} }); return true; })`);
                await waitFor(`!!document.querySelector('#gp-host .goals-close')`, `${tag}: the goal page's Close button`, 8000);
                await ev(`document.querySelector('#gp-host .goals-close').click(); true`);
                await waitFor(`!!document.querySelector('.goals-close-dialog[open]')`, `${tag}: the Close dialog`, 5000);
                await ev(`document.querySelector('.goals-close-dialog input[value="done"]').click(); document.getElementById('goal-close-reason').value = 'All done'; document.querySelector('.goals-close-dialog form').requestSubmit(); true`);
                await waitFor(`window.__goalCalls.some(c => c.kind === 'write')`, `${tag}: the close is sent`, 8000);
                const cc = await calls();
                assert.deepEqual(cc.map(x => x.kind).slice(0, 2), ['preview', 'write'], `${tag}: the dialog's close is previewed first`);
                assert.equal(cc[0].body.action, 'goal_close'); assert.equal(cc[0].body.goal, 5); assert.equal(cc[1].path, '/api/board/team-a/goals/5/close'); assert.equal(cc[1].body, cc[0].body.body, `${tag}: the dialog sends the previewed bytes`);
                assert.deepEqual(JSON.parse(cc[1].body), { subscriber_id: 'Operator', reason: 'All done', state: 'done' }, `${tag}: the body the Hub's shape allows`);

                // the Goals list's bulk close, through the UI: each goal previewed and written one at a time; the Hub's 429 stops it with its plain line
                const bulk = async (limitAt) => {
                    await ev(`window.__goalCalls.length = 0; window.__limitAt = ${limitAt}; window.__coralBulkGapMs = 30; document.getElementById('gl-host')?.remove(); import(${S} + 'goals_view.js').then(v => { const host = document.createElement('div'); host.id = 'gl-host'; document.body.appendChild(host); v.showGoals(host, '@srv1/team-a', { page: true }); return true; })`);
                    await waitFor(`document.querySelectorAll('#gl-host tbody tr').length === 3`, `${tag}: the Goals list`, 8000);
                    await ev(`document.querySelector('#gl-host .dt-check-all').click(); true`);
                    await ev(`[...document.querySelectorAll('#gl-host button')].find(b => b.textContent.trim() === 'Close goals').click(); true`);
                    await waitFor(`!!document.querySelector('#gl-host .dt-bar-apply')`, `${tag}: the bulk close bar`, 5000);
                    await ev(`(() => { const t = document.querySelector('#gl-host .dt-bar-text'); t.value = 'Wrapping up'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                    await waitFor(`!document.querySelector('#gl-host .dt-bar-apply').disabled`, `${tag}: Close goals on`, 3000);
                    await ev(`document.querySelector('#gl-host .dt-bar-apply').click(); true`);
                };
                await bulk(0);
                await waitFor(`window.__goalCalls.filter(c => c.kind === 'write').length === 3`, `${tag}: three goals closed`, 10000);
                let bc = await calls();
                assert.deepEqual(bc.map(x => x.kind), ['preview', 'write', 'preview', 'write', 'preview', 'write'], `${tag}: each goal previewed then written, one at a time`);
                assert.equal(new Set(bc.filter(x => x.kind === 'write').map(x => x.token)).size, 3, `${tag}: one token per goal`);
                assert.ok(bc.filter(x => x.kind === 'write').every(x => JSON.parse(x.body).reason === 'Wrapping up' && JSON.parse(x.body).subscriber_id === 'Operator'));
                await bulk(2); // the Hub's limit on the second preview
                await waitFor(`/half a minute\\. 1 of 3 goals was changed; the rest are unchanged\\./.test(document.body.innerText)`, `${tag}: the Hub's limit stops the bulk close with its plain line`, 10000);
                bc = await calls();
                assert.equal(bc.filter(x => x.kind === 'write').length, 1, `${tag}: only the first goal was written; the Hub's 429 stopped it, no retry`);
                assert.equal(bc.filter(x => x.kind === 'preview').length, 2, `${tag}: and no third preview was asked`);
            }
        }
        console.log('PASS');
    } finally { try { client.close(); } catch (e) {} }
}
module.exports = { run };
