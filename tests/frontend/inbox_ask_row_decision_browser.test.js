// A question with decision buttons (Monday / Friday) is answered from its Needs you ROW in one click (#20349, Beta #20340 item 5, mock v4 #20202): the click sends the reply, the row goes, the
// page says "Sent: Monday", and the detail dialog never opens. At 390 the answer is a real centre touch (#20355), so a covering element cannot be bypassed. Real server and a stood-in agent; 1280 and 390 px.
const assert = require('node:assert/strict');
const { launchStandIn } = require('./helpers/stand_in_agent');
const BASE = require('./test_base').BASE;
const { quietLaunchNotice, restoreLaunchNotice } = require('./helpers/launch_notice');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

async function httpJson(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* no body */ }
    return { status: r.status, data };
}

(async () => {
    const B = 'ar-' + Date.now().toString(36);
    let standIn = null, client = null, evp = null;
    try {
        const c = await connect(); client = c.client; const { Page, Emulation, ev, waitFor, PRELOAD, install } = c; evp = ev;
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const S = `(window.__coralStatic || '/static/')`;
        const person = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }))`);
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await quietLaunchNotice(Page, ev, BASE + '/'); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        standIn = await launchStandIn(httpJson, { displayName: 'Day Picker' });
        if (!standIn.sid) throw new Error('no stand-in agent: ' + standIn.diag);
        const tok = { 'X-Coral-Session-Token': standIn.token };
        const liveList = await (await fetch(BASE + '/api/sessions/live')).json().catch(() => []);
        const live = (Array.isArray(liveList) ? liveList : liveList.sessions || []).find(x => x.session_id === standIn.sid) || {};
        assert.ok(live.agent_type, 'the stand-in is in the live list');
        assert.ok((await httpJson('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Day Picker', job_title: 'Writer', session_name: `${live.agent_type}-${standIn.sid}` })).status < 300);
        assert.ok((await person('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'Operator', job_title: 'Operator' })).status < 300);
        const ask = async (text, buttons) => { const r = await httpJson('POST', `/api/board/${B}/messages`, { subscriber_id: 'Day Picker', content: text, ask: true, buttons }, tok); assert.equal(r.status, 200, JSON.stringify(r)); return r.data.id; };
        const mine = async () => (await person('GET', '/api/operator-asks')).data.filter(a => a.board === B);

        for (const width of [1280, 390]) {
            const q = `Which day should the release go out ${width}?`;
            const id = await ask(`@Operator ${q}`, ['Monday=reply', 'Friday=reply']);
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
            await Emulation.setTouchEmulationEnabled({ enabled: width < 768 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await quietLaunchNotice(Page, ev, BASE + '/'); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
            const row = `[...document.querySelectorAll('#group-table-view tbody tr')].find(r => r.textContent.includes(${JSON.stringify(q)}))`;
            await waitFor(`!!(${row})`, width + ': the question has a row', 15000);
            const labels = await ev(`[...(${row}).querySelectorAll('button.inbox-offer')].map(b => b.textContent)`);
            assert.deepEqual(labels, ['Monday', 'Friday'], width + ': the decision buttons are on the row: ' + JSON.stringify(labels));
            const size = await ev(`(() => { const b = (${row}).querySelector('button.inbox-offer'); const r = b.getBoundingClientRect(); return { h: r.height, w: r.width }; })()`);
            assert.ok(size.h >= 28 && size.w > 30, width + ': the button is a real target ' + JSON.stringify(size));
            const replies = async () => (await httpJson('GET', `/api/board/${B}/messages?subscriber_id=Day%20Picker`, undefined, tok)).data.filter(m => m.subscriber_id === 'Operator' && m.content.includes('Monday')).length;
            const before = await replies();
            if (width === 390) { // #20355: a DOM click bypasses the hit test and cannot catch a covering element.
                const tap = await ev(`(() => { const b = [...(${row}).querySelectorAll('button.inbox-offer')].find(b => b.textContent === 'Monday'); b.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, hit: !!hit && (hit === b || b.contains(hit)) }; })()`);
                assert.ok(tap.hit, '390: the centre of Monday is not covered: ' + JSON.stringify(tap));
                await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: tap.x, y: tap.y }] });
                await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] });
            } else await ev(`[...(${row}).querySelectorAll('button.inbox-offer')].find(b => b.textContent === 'Monday').click(); true`);
            await waitFor(`!(${row})`, width + ': the row goes after one click', 8000);
            assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`), false, width + ': no detail dialog opened');
            assert.ok(!(await mine()).some(a => a.id === id), width + ': the question is closed');
            assert.equal((await replies()) - before, 1, width + ': the agent got the reply once');
            await waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Sent: Monday'))`, width + ': the toast says Sent: Monday', 4000);
            console.log('PASS one answer without a dialog at ' + width + (width === 390 ? ' by native centre touch' : ' by click'));
        }
        console.log('PASS inbox_ask_row_decision');
    } finally { try { await restoreLaunchNotice(evp); } catch (e) {} if (standIn) await standIn.stop().catch(() => {}); if (evp) await removeBoards(evp, [B]).catch(() => {}); if (client) await client.close().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
