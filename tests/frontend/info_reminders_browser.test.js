// An agent on no team has no team page, so its Reminders are in its Info tab (#19531, the Operator): the same section as the team agent page (Chief's cards and editor), the reminders it has, and New reminder,
// which names the agent by its session (no team, no member). An agent on a team gets none here (its team page has them); a refused read (the Hub) draws nothing; the section follows the agent picked.
// At 1280 and 390 px: nothing runs past the panel sideways and the buttons are 44 px tall.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
        await ev(`(async () => {
            const st = window.__coralStatic || '/static/';
            window.__state_ = (await import(st + 'state.js')).state; window.__tab_ = await import(st + 'info_tab.js');
            window.__rem = { status: 200, posts: [], deletes: [], next: 10, rows: [
                { id: 1, name: 'Check CI', schedule_kind: 'interval', every_minutes: 15, target_session: '${SID}', target_board: '', origin: 'operator', paused: false },
                { id: 3, name: 'Not mine', schedule_kind: 'daily', at: '08:00', timezone: 'UTC', target_session: 'bbbbbbbb-1111-4222-8333-444444444444', target_board: '', origin: 'operator', paused: false }] };
            window.__rem.seed = JSON.stringify(window.__rem.rows);
            const prev = window.fetch, json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u && u.url || u), location.origin), m = (o.method || 'GET').toUpperCase();
                if (/^\\/api\\/sessions\\/live\\/[^/]+\\/info$/.test(url.pathname)) return json({ agent_name: 'Solo', agent_type: 'claude', tmux_command: 'tmux attach -t x' });
                if (/\\/mcp-servers$|\\/loaded-skills$|\\/memory$/.test(url.pathname)) return json({ supported: false, skills: [], files: [] });
                if (url.pathname === '/api/reminders' && m === 'GET') return window.__rem.status === 200 ? json({ reminders: window.__rem.rows }) : json({ error: 'not_available_through_hub' }, window.__rem.status);
                if (url.pathname === '/api/reminders' && m === 'POST') { const b = JSON.parse(o.body); window.__rem.posts.push(b); window.__rem.rows.push({ id: window.__rem.next++, name: b.text, schedule_kind: b.kind === 'every' ? 'interval' : b.kind, at: b.at, every_minutes: b.every_minutes, timezone: b.timezone, target_session: '${SID}', target_board: '', origin: 'operator', paused: false }); return json({ id: 99 }, 201); }
                const d = url.pathname.match(/^\\/api\\/reminders\\/(\\d+)$/);
                if (d && m === 'DELETE') { window.__rem.deletes.push(d[1]); window.__rem.rows = window.__rem.rows.filter(x => String(x.id) !== d[1]); return json({ ok: true }); }
                return prev(u, o); };
            return true; })()`);
        const live = (extra) => ev(`window.__state_.currentSession = Object.assign({ type: 'live', name: 'Solo', agent_type: 'claude', session_id: '${SID}', server: 'local' }, ${JSON.stringify(extra || {})}); true`);
        const show = () => ev(`(document.getElementById('agentic-state').classList.remove('collapsed'), (document.getElementById('agentic-state').dataset.page = 'agent'), document.body.setAttribute('data-dock-page', 'agent'), window.__tab_.openInfoTab(), window.__tab_.showInfoTab()).then(() => new Promise(r => setTimeout(() => r(true), 400)))`);
        const cards = () => ev(`[...document.querySelectorAll('#info-reminders .chief-check-card')].map(c => c.textContent)`);
        for (const [w, h] of [[1280, 900], [390, 800]]) {
            console.log(w + ' px');
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
            await ev(`window.__rem.status = 200; window.__rem.posts = []; window.__rem.deletes = []; window.__rem.rows = JSON.parse(window.__rem.seed); true`);
            await live(); await show();
            let c = await cards();
            assert.equal(c.length, 1, 'only this agent\'s reminder is listed: ' + JSON.stringify(c));
            assert.match(c[0], /Check CI/); assert.match(c[0], /Every 15 minutes/);
            assert.equal(await ev(`!!document.querySelector('#info-reminders h3') && document.querySelector('#info-reminders h3').textContent`), 'Reminders');

            await ev(`document.querySelector('#info-reminders .agent-rem-new').click(); true`); await waitFor(`!!document.querySelector('dialog.chief-check-editor')`, 'the editor');
            assert.deepEqual(await ev(`[...document.querySelectorAll('dialog.chief-check-editor label')].map(l => l.firstChild.textContent)`), ['Instruction', 'Schedule', 'Repeat every', 'Day', 'Date and time'], 'Chief\'s editor, the interval is "Repeat every"');
            await ev(`(() => { const f = document.querySelector('dialog.chief-check-editor form'), set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
                set(f.querySelector('textarea'), 'Look at the soak'); set(f.querySelector('input[type=datetime-local]'), '2030-01-02T09:30'); f.querySelector('button[type=submit]').click(); return true; })()`);
            await waitFor(`window.__rem.posts.length === 1`, 'the post');
            const p = await ev(`window.__rem.posts[0]`);
            assert.equal(p.session_id, SID, 'the request names the agent by its session');
            assert.equal(p.board, undefined); assert.equal(p.to, undefined);
            assert.equal(p.kind, 'once'); assert.equal(p.at, '2030-01-02T09:30'); assert.equal(p.text, 'Look at the soak');
            await waitFor(`document.querySelectorAll('#info-reminders .chief-check-card').length === 2`, 'listed after adding');

            const over = await ev(`(() => { const t = document.getElementById('agentic-panel-info'); const b = [...document.querySelectorAll('#info-reminders button')]; return { side: t.scrollWidth > t.clientWidth + 1, short: b.filter(x => parseFloat(getComputedStyle(x).minHeight) < 44 || (x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().height < 44)).map(x => x.textContent) }; })()`);
            assert.equal(over.side, false, 'nothing runs past the panel sideways'); assert.deepEqual(over.short, [], 'buttons are 44 px tall (the phone sheet is not opened by this harness, so its buttons are held to the style rule)');

            await ev(`[...document.querySelectorAll('#info-reminders .chief-check-card')][0].querySelector('button').click(); true`);
            await ev(`[...document.querySelectorAll('#info-reminders .chief-check-card')][0].querySelector('button').click(); true`);
            await waitFor(`window.__rem.deletes.length === 1`, 'the delete');
            await waitFor(`document.querySelectorAll('#info-reminders .chief-check-card').length === 1`, 'one left');

            await live({ board_project: 'team-a' }); await show();
            assert.equal((await cards()).length, 0, 'an agent on a team has its Reminders on its team page, not here');
            await ev(`window.__rem.status = 404; true`); await live(); await show();
            assert.equal(await ev(`document.querySelector('#info-reminders').children.length`), 0, 'a refused read (the Hub) draws nothing');
        }
        console.log('PASS an agent on no team has its Reminders in its Info tab (1280, 390)');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
