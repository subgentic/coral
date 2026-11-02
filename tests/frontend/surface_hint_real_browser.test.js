// Which part of the page an action was taken in (#12158): the page says it in an X-Coral-Surface header taken from where the last real click or key landed (the Inbox, or an agent's chat or terminal), for a few
// seconds, and the Activity record keeps it as one of two words or nothing. Against the REAL isolated server: a goal closed by the Operator right after a real mouse click in an Inbox area is recorded inbox,
// after a click in a chat area chat, with no recent click nothing, and a click a while ago nothing; Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'srf-' + Date.now().toString(36);
    const SID = 'd1b2c3d4-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const click = async id => {
        const r = await ev(`(() => { const b = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const newGoal = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g)); return g.body.id || (g.body.goal && g.body.goal.id); };
    const close = async (id) => { const c = await api('POST', `/api/board/${B}/goals/${id}/close`, { subscriber_id: 'Operator', reason: 'done' }); assert.equal(c.status, 200, JSON.stringify(c)); };
    const surfaceOf = async title => { const r = await api('GET', '/api/activity?limit=50'); const row = (r.body.actions || []).find(a => a.title === title); assert.ok(row, 'a row for ' + title + ' in ' + JSON.stringify(r.body.actions)); return row.surface || ''; };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-' + SID })).status < 300);
        await ev(`for (const [id, area] of [['zz-inbox', 'inbox'], ['zz-chat', 'chat'], ['zz-other', '']]) { const b = document.createElement('button'); b.id = id; b.textContent = id; b.style.cssText = 'position:fixed;left:' + (20 + ['zz-inbox','zz-chat','zz-other'].indexOf(id) * 140) + 'px;top:200px;z-index:99999;width:120px;height:40px'; if (area) b.dataset.surface = area; document.body.append(b); } true`);
        const [g1, g2, g3, g4, g5] = [await newGoal('no click'), await newGoal('inbox click'), await newGoal('chat click'), await newGoal('stale click'), await newGoal('other click')];

        console.log('1. No recent click: nothing');
        await new Promise(r => setTimeout(r, 5600)); // sleep-ok: any click the page saw while it loaded is older than the hint's few seconds
        await close(g1);
        assert.equal(await surfaceOf('no click'), '');
        console.log('   ✓');
        console.log('2. A real click in an Inbox area, then the write: inbox');
        await click('zz-inbox'); await close(g2);
        assert.equal(await surfaceOf('inbox click'), 'inbox');
        console.log('   ✓');
        console.log('3. A real click in a chat area, then the write: chat');
        await click('zz-chat'); await close(g3);
        assert.equal(await surfaceOf('chat click'), 'chat');
        console.log('   ✓');
        console.log('4. A click somewhere else says nothing, and a click a while ago says nothing');
        await click('zz-other'); await close(g5);
        assert.equal(await surfaceOf('other click'), '');
        await click('zz-inbox');
        await new Promise(r => setTimeout(r, 5600)); // sleep-ok: the hint is kept for a few seconds only
        await close(g4);
        assert.equal(await surfaceOf('stale click'), '');
        console.log('   ✓');
        console.log('PASS surface hint: inbox, chat, nothing; a stale click and another area say nothing');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
