// #19355 (backend #18553): a single agent's question row in Needs you has "Answered in chat" beside Dismiss. It posts {answered_in_chat:true} to /api/agent-asks/<id>/dismiss (Dismiss posts {}), says so in a toast with
// Undo (which posts {undo:true}), and the question leaves Needs you. A team's (board) question has no such button. The routes are stood in (fetch). 1280 px, and 390 px where the button is in the row's menu.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [width, mobile] of [[1280, false], [390, true]]) {
            const at = `${width} px: `;
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(() => { window.__dismissed = []; window.__open = true; const R = window.fetch.bind(window), json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const url = String(u && u.url ? u.url : u), post = (o.method || 'GET').toUpperCase() === 'POST';
                    if (url === '/api/operator-asks') return json(window.__open ? [{ board: '', kind: 'agent', id: 31, asker: 'Notes builder', text: 'Which database should the notes app use?', at: new Date(Date.now() - 60000).toISOString() }, { board: 'team-x', kind: 'ask', id: 7, asker: 'Planner', text: 'Ship tonight or wait?', at: new Date(Date.now() - 120000).toISOString() }] : [{ board: 'team-x', kind: 'ask', id: 7, asker: 'Planner', text: 'Ship tonight or wait?', at: new Date(Date.now() - 120000).toISOString() }]);
                    if (post && /\\/api\\/agent-asks\\/31\\/dismiss$/.test(url)) { const b = JSON.parse(o.body || '{}'); if (window.__fail) { window.__failed = (window.__failed || 0) + 1; return json({ message: 'The question is already closed.' }, 409); } window.__dismissed.push(b); window.__open = !!b.undo; return json({ ok: true }); }
                    return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); import(${S} + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => import(${S} + 'inbox_tab.js')).then(m => m.selectInboxTab('needs')).then(() => true)`);
            await waitFor(`document.querySelectorAll('#group-table-view .inbox-ask-name, #group-table-view .inbox-review-name').length >= 2`, `${at}both questions`, 15000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`document.getElementById('group-table-view').innerText.slice(0, 400)`))); });
            const row = who => `[...document.querySelectorAll('#group-table-view tbody tr')].find(tr => tr.textContent.includes(${JSON.stringify(who)}))`;
            const chat = who => `(() => { const tr = ${row(who)}; return tr ? [...tr.querySelectorAll('button')].find(b => /Answered in chat/.test(b.textContent)) : null; })()`;
            if (mobile) {
                await ev(`(() => { const tr = ${row('Notes builder')}; const dots = tr.querySelector('.inbox-more-btn, [data-slot="dots"] button, button[aria-haspopup]'); dots.click(); return true; })()`);
                await waitFor(`[...document.querySelectorAll('[role=menuitem], .more-menu button, .dt-menu button')].some(b => /Answered in chat/.test(b.textContent))`, `${at}the menu offers Answered in chat`, 8000);
                await ev(`[...document.querySelectorAll('[role=menuitem], .more-menu button, .dt-menu button')].find(b => /Answered in chat/.test(b.textContent)).click(); true`);
            } else {
                assert.equal(await ev(`!!${chat('Planner')}`), false, `${at}a team's question has no Answered in chat`);
                assert.equal(await ev(`!!${chat('Notes builder')}`), true, `${at}the agent's question has it`);
                assert.ok(await ev(`[...${row('Notes builder')}.querySelectorAll('button')].some(b => /^Dismiss$/.test(b.textContent))`), `${at}beside Dismiss`);
                // a refused close (HTTP 409) says why in the row and leaves the button usable again
                await ev(`window.__fail = true; ${chat('Notes builder')}.click(); true`);
                await waitFor(`window.__failed === 1`, `${at}the refused close was sent`, 8000);
                await waitFor(`/already closed/.test((${row('Notes builder')} || { textContent: '' }).querySelector('.inbox-review-error')?.textContent || '')`, `${at}the row says why it was refused`, 8000);
                await ev(`import(${S} + 'inbox_sidebar.js').then(m=>m.showInbox({folder:'needs'})).then(()=>true)`);
                await waitFor(`/already closed/.test((${row('Notes builder')} || { textContent: '' }).querySelector('.inbox-review-error')?.textContent || '')`, `${at}refusal survives a list redraw`, 8000);
                assert.equal(await ev(`${chat('Notes builder')}.disabled`), false, `${at}Answered in chat is usable again after a refusal`);
                assert.equal(await ev(`window.__dismissed.length`), 0, `${at}nothing was closed`);
                await ev(`window.__fail = false; ${chat('Notes builder')}.click(); true`);
            }
            await waitFor(`window.__dismissed.length === 1`, `${at}the click posts`, 8000);
            assert.deepEqual(await ev(`window.__dismissed[0]`), { answered_in_chat: true }, `${at}answered_in_chat, not a plain dismiss`);
            await waitFor(`!${row('Notes builder')}`, `${at}the question leaves Needs you`, 8000);
            await waitFor(`/Marked answered in chat/.test(document.body.textContent) && [...document.querySelectorAll('button')].some(b => b.textContent === 'Undo')`, `${at}the toast says so, with Undo`, 8000);
            await ev(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Undo').click(); true`);
            await waitFor(`window.__dismissed.length === 2`, `${at}Undo posts`, 8000);
            assert.deepEqual(await ev(`window.__dismissed[1]`), { undo: true }, `${at}Undo is undo`);
            await waitFor(`!!${row('Notes builder')}`, `${at}the question is back`, 8000);
        }
        console.log('\nPASS a single agent question can be closed as answered in chat, with Undo; a team question has no such button');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
