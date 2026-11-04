// #13425: the home-folder question in the page. A launch or a wake the server answers 409 home_folder opens the confirmation ("Launch anyway" / "Wake anyway", "Pick a folder"); Pick a folder (or Escape) sends nothing
// more; Launch anyway sends the same request again with confirm_home_folder. Every first request says home_folder_ask (the server asks only a page that can answer). A stub answers the routes: nothing starts.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup');
        await ev(`(() => { const R = window.fetch; window.__sent = []; window.__ask = true;
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), p = url.pathname, method = (o.method || 'GET').toUpperCase();
                const wake = /^\\/api\\/sessions\\/live\\/hf-1\\/wake$/.test(p), launch = p === '/api/sessions/launch' && method === 'POST';
                if (!wake && !launch) return R(u, o);
                const body = o.body ? JSON.parse(o.body) : {}, confirmed = body.confirm_home_folder === true;
                window.__sent.push({ route: wake ? 'wake' : 'launch', search: url.search, body });
                // a board of that name exists (the server asks this first): the person's choice must still be in the request that Launch anyway sends (UI Reviewer's MUST on 19662b2bb)
                if (launch && window.__dup && !body.board_id && !body.new_board) return json({ error: 'board_name_exists', code: 'board_name_exists', message: 'exists', candidates: [{ board_id: 'chosen-team-id', board_label: 'Dup', members: 2, live_agents: 1 }] }, 409);
                if (!confirmed) return json({ ok: false, code: 'home_folder', error: 'This agent will work in your whole home folder; pick a project folder?', message: 'This agent will work in your whole home folder; pick a project folder?' }, 409);
                return json(wake ? { ok: true, sleeping: false } : { ok: true, session_id: 'hf-1', name: 'x' }, 200); };
            return true; })()`);
        const open = () => ev(`(() => { const d = document.getElementById('confirm-modal'); return !!d && getComputedStyle(d).display !== 'none'; })()`);
        const yesLabel = () => ev(`document.getElementById('confirm-modal-yes').textContent`);
        const noLabel = () => ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').textContent`);

        // a launch: asked, Pick a folder sends nothing more
        await ev(`window.__r = 'pending'; import(${S} + 'launch_core.js').then(m => m._launchOn('local', '/api/sessions/launch', { agent_type: 'claude', working_dir: '/home/x' }, 'claude')).then(v => { window.__r = v; }); true`);
        await waitFor(`document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question opens', 8000);
        assert.match(await ev(`document.getElementById('confirm-modal-title').textContent`), /home folder/);
        assert.match(await ev(`document.getElementById('confirm-modal-message').textContent`), /whole home folder; pick a project folder/);
        assert.equal(await yesLabel(), 'Launch anyway'); assert.equal(await noLabel(), 'Pick a folder');
        let sent = await ev(`window.__sent`);
        assert.equal(sent.length, 1); assert.equal(sent[0].body.home_folder_ask, true, 'the first request says the page can answer'); assert.equal(sent[0].body.confirm_home_folder, undefined);
        await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
        await waitFor(`window.__r === null`, 'Pick a folder ends the launch with nothing launched', 6000);
        assert.equal((await ev(`window.__sent`)).length, 1, 'nothing more was sent');

        // Launch anyway: the same launch again with confirm_home_folder
        await ev(`window.__sent.length = 0; window.__r = 'pending'; import(${S} + 'launch_core.js').then(m => m._launchOn('local', '/api/sessions/launch', { agent_type: 'claude', working_dir: '/home/x' }, 'claude')).then(v => { window.__r = v; }); true`);
        await waitFor(`document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the question opens again', 8000);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__r && window.__r.ok === true`, 'Launch anyway launches', 6000);
        sent = await ev(`window.__sent`);
        assert.equal(sent.length, 2); assert.equal(sent[1].body.confirm_home_folder, true); assert.equal(sent[1].body.home_folder_ask, true); assert.equal(sent[1].body.working_dir, '/home/x', 'the same launch');

        // a duplicate board name, then the home folder: each choice survives into the confirmed launch
        for (const [choice, selector, check] of [['Join it', '#confirm-modal-none, .board-choice-modal button[data-board-id]', b => b.board_id === 'chosen-team-id' && b.board_name === 'chosen-team-id'], ['Create another', '.board-choice-modal button[data-action="new"]', b => b.new_board === true]]) {
            await ev(`window.__sent.length = 0; window.__dup = true; window.__r = 'pending'; import(${S} + 'launch_core.js').then(m => m._launchOn('local', '/api/sessions/launch', { agent_type: 'claude', working_dir: '/home/x', board_name: 'Dup' }, 'claude')).then(v => { window.__r = v; }); true`);
            await waitFor(`!!document.querySelector('.board-choice-modal')`, 'the duplicate-name choice opens (' + choice + ')', 8000);
            await ev(`document.querySelector(${JSON.stringify(selector.split(', ').pop())}).click(); true`);
            await waitFor(`document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'then the home-folder question opens (' + choice + ')', 8000);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__r && window.__r.ok === true`, 'Launch anyway launches (' + choice + ')', 6000);
            const last = (await ev(`window.__sent`)).pop().body;
            assert.ok(check(last), choice + ': the chosen board is kept in the confirmed launch: ' + JSON.stringify(last));
            assert.equal(last.confirm_home_folder, true);
        }
        await ev(`window.__dup = false; true`);

        // a wake: the first request says home_folder_ask; Wake anyway sends it again with confirm_home_folder
        await ev(`window.__sent.length = 0; window.__w = 'pending'; Promise.resolve(window.toggleAgentSleep('x', 'claude', 'hf-1', 'wake')).then(v => { window.__w = v; }); true`);
        await waitFor(`document.getElementById('confirm-modal') && getComputedStyle(document.getElementById('confirm-modal')).display !== 'none'`, 'the wake question opens', 8000);
        assert.equal(await yesLabel(), 'Wake anyway');
        sent = await ev(`window.__sent`);
        assert.equal(sent.length, 1); assert.equal(sent[0].search, '', 'no query: the Hub refuses one it does not list'); assert.equal(sent[0].body.home_folder_ask, true); assert.equal(sent[0].body.confirm_home_folder, undefined);
        await ev(`document.getElementById('confirm-modal-yes').click(); true`);
        await waitFor(`window.__w === true`, 'Wake anyway wakes', 6000);
        sent = await ev(`window.__sent`);
        assert.equal(sent.length, 2); assert.equal(sent[1].search, ''); assert.equal(sent[1].body.home_folder_ask, true); assert.equal(sent[1].body.confirm_home_folder, true);
        console.log('home_folder_ask_browser: ok');
    } finally { try { await client.close(); } catch {} }
})().catch(e => { console.error(e); process.exit(1); });
