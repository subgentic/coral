// #17537, walk 76: after ten minutes away the Inbox said nothing about what had happened. Coming back after five minutes or more, Needs you has one quiet line, "While you were away (12 min): 2 tasks
// done, 1 goal done, 3 agents idle.": counts from GET /api/away (stubbed here) and the agents idle now from the live list, a Dismiss that stays dismissed, nothing when nothing happened, nothing when
// the setting is off or the read fails, and the module is not loaded before Needs you is shown. The gap is made by moving the page's clock (Date.now) forward and then pressing something: the module watches input itself.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const LINE = `document.querySelector('#group-table-view .inbox-away')`;
    const idle = n => Array.from({ length: n }, (_, i) => ({ session_id: 'idle-' + i, name: 'a' + i, agent_type: 'claude', display_name: 'Agent ' + i, working: false, starting: false }));
    const working = { session_id: 'busy', name: 'busy', agent_type: 'claude', display_name: 'Busy', working: true };
    let failed = 0;
    const check = (label, fn) => { try { fn(); console.log('[PASS] ' + label); } catch (e) { failed++; console.log('[FAIL] ' + label + ' - ' + e.message); } };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // each case: the answer the stub gives, the live agents, the setting, and when the person went away (minutes ago)
    const arrive = async ({ away, agents, setting, minutes, status = 200 }) => {
        await ev(`(async () => { window.__asked = [];
            if (!window.__stubbed) { window.__stubbed = true; const R = window.fetch.bind(window);
                window.fetch = (u, o) => { const s = String(u && u.url || u); if (/\\/api\\/away/.test(s)) { window.__asked.push(s); return Promise.resolve(new Response(JSON.stringify(window.__away || {}), { status: window.__awayStatus || 200, headers: { 'content-type': 'application/json' } })); } return R(u, o); }; }
            window.__away = ${JSON.stringify(away)}; window.__awayStatus = ${status};
            const st = await import(${S} + 'state.js'); st.state.liveSessions = ${JSON.stringify(agents)}; st.state.settings = Object.assign({}, st.state.settings, { inbox_away: ${JSON.stringify(setting)} });
            if (window.__off === undefined) { window.__off = 0; const RN = Date.now; Date.now = () => RN.call(Date) + window.__off; }
            const m = await import(${S} + 'inbox_tab.js'); await m.selectInboxTab('needs'); await import(${S} + 'inbox_away.js'); await new Promise(r => setTimeout(r, 100)); // sleep-ok: the banner's own import of the module settles
            document.dispatchEvent(new Event('pointerdown'));
            window.__off += ${minutes} * 60000; document.dispatchEvent(new Event('pointerdown')); return true; })()`);
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
        const early = await ev(`performance.getEntriesByType('resource').some(r => /inbox_away\\.(js|css)/.test(r.name))`);
        check('nothing of the line is requested before Needs you is shown', () => assert.equal(early, false));

        await ev(`window.switchNavTab && window.switchNavTab('hub-inbox'); true`);
        await waitFor(`!!document.querySelector('#group-table-view')`, 'the Inbox', 15000);
        await arrive({ away: { tasks_done: 2, goals_done: 1 }, agents: [...idle(3), working, {session_id:'unknown',name:'unknown',agent_type:'claude'}, {...working,session_id:'starting',working:false,starting:true}, {...working,session_id:'waiting',working:false,starting:false,waiting_for_input:true}], setting: 'true', minutes: 12 });
        await waitFor(`!!${LINE}`, 'the line', 8000);
        let t = await ev(`({ text: ${LINE}.textContent, role: ${LINE}.getAttribute('role'), btn: [...${LINE}.querySelectorAll('button')].map(b => b.textContent), asked: window.__asked.length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth })`);
        check('the line counts tasks and goals from the server and the agents idle now, a working one not counted', () => assert.match(t.text, /^While you were away \(12 min\): 2 tasks done, 1 goal done, 3 agents idle\.Dismiss$/, t.text));
        check('it is a status with one Dismiss, and no sideways scroll', () => assert.ok(t.role === 'status' && t.btn.length === 1 && t.btn[0] === 'Dismiss' && t.over <= 0, JSON.stringify(t)));
        check('the server was asked once, for that time', () => assert.equal(t.asked, 1, JSON.stringify(t)));
        // Change a real row so refreshGroupTable cannot stop at its unchanged-signature fast path.
        // Each redraw must replace the table and mount its banner through the normal Needs you renderer.
        for (let i = 0; i < 12; i++) {
            const name = `Waiting redraw ${i}`;
            await ev(`(async () => {
                const { state } = await import(${S} + 'state.js'), groups = await import(${S} + 'sidebar_groups.js');
                window.__awayOldTable = document.querySelector('#group-table-view .dt-box');
                window.__awayOldDrawn = document.getElementById('group-table-view').dataset.drawn;
                state.liveSessions = state.liveSessions.map(s => s.session_id === 'waiting' ? { ...s, display_name: ${JSON.stringify(name)} } : s);
                groups.refreshGroupTable('hub-inbox'); return true;
            })()`);
            await waitFor(`window.__awayOldTable && !window.__awayOldTable.isConnected && document.getElementById('group-table-view').dataset.drawn !== window.__awayOldDrawn && document.querySelector('#group-table-view tbody')?.textContent.includes(${JSON.stringify(name)})`, 'real Needs you table redraw ' + (i + 1));
            await waitFor(`!!${LINE}`, 'away summary after real redraw ' + (i + 1));
            assert.equal(await ev(`document.querySelectorAll('.inbox-away').length`), 1, 'one away line after real redraw ' + (i + 1));
        }
        console.log('[PASS] one away line after each of 12 real Needs you table redraws');
        await shot('inbox-away-line');
        await ev(`${LINE}.querySelector('button').click(); true`);
        await waitFor(`!${LINE}`, 'the line goes', 4000);
        await ev(`import(${S} + 'inbox_tab.js').then(m => m.selectInboxTab('needs')).then(() => true)`);
        await new Promise(r => setTimeout(r, 600)); // sleep-ok: the absence of the line has nothing to wait for
        const back = await ev(`({ line: !!${LINE}, asked: window.__asked.length })`);
        check('Dismiss stays dismissed through a redraw, and nothing is asked again', () => assert.deepEqual(back, { line: false, asked: 1 }));

        await arrive({ away: { tasks_done: 0, goals_done: 0 }, agents: [working], setting: 'true', minutes: 30 });
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the absence of the line has nothing to wait for
        const quiet = await ev(`!!${LINE}`);
        check('nothing happened and nobody is idle: no line', () => assert.equal(quiet, false));

        await arrive({ away: { tasks_done: 1, goals_done: 0 }, agents: [], setting: 'false', minutes: 20 });
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the absence of the line has nothing to wait for
        const off = await ev(`({ line: !!${LINE}, asked: window.__asked.length })`);
        check('switched off in Settings > Inbox: no line and nothing is asked', () => assert.deepEqual(off, { line: false, asked: 0 }));

        await arrive({ away: { error: 'no' }, agents: idle(2), setting: 'true', minutes: 40, status: 500 });
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the absence of the line has nothing to wait for
        const bad = await ev(`!!${LINE}`);
        check('a failed read says nothing', () => assert.equal(bad, false));

        await arrive({ away: { tasks_done: 1, goals_done: 0 }, agents: [], setting: 'true', minutes: 90 });
        await waitFor(`!!${LINE}`, 'the line after a long gap', 8000);
        t = await ev(`${LINE}.textContent`);
        check('a long gap is said in hours and minutes', () => assert.match(t, /^While you were away \(1 h 30 min\): 1 task done\./, t));
    } finally { await client.close(); }
    if (failed) { console.error(failed + ' failed'); process.exit(1); }
    console.log('\nAll while-you-were-away checks passed');
})().catch(e => { console.error(e); process.exit(1); });
