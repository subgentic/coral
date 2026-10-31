// The Guides group of Team settings (#11457): the names agents see on a guide's messages. Against the real server for the board, with a thin layer over fetch for GET and PUT guide-roster and its refusals. Checked: the group
// lists each guide by its Hub label with the name field (the placeholder says "not named yet"); Save sends the whole roster, named guides only, as {roster: {label: name}}; Remove name and Add a guide change the list and are
// unsaved changes; a label that is not hub-user- and eight hex is refused in the form; the words under the list say where access is stopped (Coral Hub); a refusal of the read removes the group; 44 px targets at 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const TEAM = 'gr-team-' + Date.now().toString(36);
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const settle = (ms, quietMs = 120) => require('./helpers/wait').settle(ev, ms, quietMs);
    const board = (p, method, body) => ev(`fetch('/api/board/${TEAM}${p}', { method: '${method}', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => ({ status: r.status }))`);
    const layer = () => ev(`(() => { if (!window.__realFetch) window.__realFetch = window.fetch; const R = window.__realFetch; window.__gr = { get: { status: 200, body: { roster: { 'hub-user-3f2a9c1d': 'Priya (design)', 'hub-user-b81e07aa': '' } } }, puts: [] };
        const json = (b, s) => Promise.resolve(new Response(JSON.stringify(b), { status: s || 200, headers: { 'content-type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
            if (p === '/api/board/${TEAM}/guide-roster' && m === 'GET') return json(window.__gr.get.body, window.__gr.get.status);
            if (p === '/api/board/${TEAM}/guide-roster' && m === 'PUT') { const b = JSON.parse(o.body); window.__gr.puts.push(b); return json({ roster: b.roster }); }
            return R(u, o); }; return true; })()`);
    const open = async () => {
        await ev(`document.getElementById('team-settings-workspace')?.remove(); import(${S} + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host' }))) })); true`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=messaging]')`, 'the settings page', 15000);
        await settle(200);
    };
    const P = '#team-settings-guides';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').coralReady(ev);
            const sub = await board('/subscribe', 'POST', { subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'claude-0b7c2e4a-5d1f-4c8e-9a36-2f4d8e1b7c90' });
            assert.ok(sub.status < 300, JSON.stringify(sub));
            await layer(); await open();
            check(await ev(`!!document.querySelector('#team-settings-workspace .settings-tab[data-section=guides]')`), `${tag}: the Guides group is there`);
            await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=guides]').click(); true`); await settle(150);
            const rows = await ev(`[...document.querySelectorAll('${P} .gr-guide')].map(r => [r.querySelector('.gr-label').textContent, r.querySelector('input').value, r.querySelector('input').placeholder])`);
            check(JSON.stringify(rows) === JSON.stringify([['Guide hub-user-3f2a9c1d', 'Priya (design)', 'Name agents see (not named yet)'], ['Guide hub-user-b81e07aa', '', 'Name agents see (not named yet)']]), `${tag}: a row per guide, by its Hub label: ` + JSON.stringify(rows));
            check(await ev(`/remove them in Coral Hub/.test(document.querySelector('${P}').textContent) && /Until you name them, a guide shows as their Coral Hub label/.test(document.querySelector('${P}').textContent)`), `${tag}: the words say where access is stopped and what an unnamed guide shows as`);
            if (mobile) check(await ev(`[...document.querySelectorAll('${P} button, ${P} input')].every(e => e.getClientRects().length === 0 || e.getBoundingClientRect().height >= 44)`), `${tag}: every control is 44 px`);
            // name the second guide and save: the whole roster, named guides only
            await ev(`(() => { const i = document.querySelectorAll('${P} .gr-guide input')[1]; i.value = 'Sam'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!document.querySelector('#team-settings-workspace .sv-save').disabled`, `${tag}: naming a guide is an unsaved change`, 4000);
            await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`);
            await waitFor(`window.__gr.puts.length === 1`, `${tag}: Save sends the roster`, 6000);
            check(JSON.stringify(await ev(`window.__gr.puts[0]`)) === JSON.stringify({ roster: { 'hub-user-3f2a9c1d': 'Priya (design)', 'hub-user-b81e07aa': 'Sam' } }), `${tag}: the whole roster, as {roster: {label: name}}: ` + JSON.stringify(await ev(`window.__gr.puts[0]`)));
            // Add a guide: a bad label is refused in the form, a good one is added
            await ev(`(() => { const i = document.querySelector('${P} .gr-add input'); i.value = 'priya@example.com'; document.querySelector('${P} .gr-add button').click(); return true; })()`);
            check(await ev(`/looks like hub-user-/.test(document.querySelector('${P} .gr-say').textContent) && document.querySelectorAll('${P} .gr-guide').length === 2`), `${tag}: a label that is not hub-user- and eight hex is refused`);
            await ev(`(() => { const i = document.querySelector('${P} .gr-add input'); i.value = 'HUB-USER-0a1b2c3d'; document.querySelector('${P} .gr-add button').click(); return true; })()`);
            check(await ev(`document.querySelectorAll('${P} .gr-guide').length === 3 && document.querySelectorAll('${P} .gr-label')[2].textContent === 'Guide hub-user-0a1b2c3d'`), `${tag}: a good label is added, lower-cased`);
            check(await ev(`document.activeElement && document.activeElement.classList.contains('gr-name') && document.activeElement.closest('.gr-guide') === document.querySelector('${P} .gr-guide:last-of-type')`), `${tag}: the new row's name field has the focus`);
            // Remove name
            await ev(`document.querySelector('${P} .gr-guide:last-of-type .gr-remove').click(); true`);
            check(await ev(`document.querySelectorAll('${P} .gr-guide').length === 2`), `${tag}: Remove name takes the row out`);
            // a refusal of the read removes the group
            await ev(`window.__gr.get = { status: 403, body: { error: 'owner only' } }; true`);
            await open();
            check(await ev(`!document.querySelector('#team-settings-workspace .settings-tab[data-section=guides]')`), `${tag}: a page that may not read the roster has no Guides group`);
            await ev(`window.fetch = window.__realFetch; true`);
        }
        assert.equal(found.length, 0, '\n' + found.join('\n'));
        console.log('PASS the Guides group names guides and saves the roster');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
