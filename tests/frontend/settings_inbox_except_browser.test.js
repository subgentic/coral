// #15881 (ST7, guideline 4.12 rule 9): the Inbox's teams start as one line, "All teams", with an Except… picker, not one tick box per team. The saved value is unchanged: "all", or the list of teams.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, nextFrame } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            const tag = w + ' px';
            const teams = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const url = new URL(String(u), location.href); if (url.pathname === '/api/settings' && (o.method || 'GET').toUpperCase() === 'PUT') return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })); /* the dialog saves as it changes: nothing reaches the server here */ if (url.pathname === '/api/board/projects') return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(teams)}.map(p => ({ project: p }))), { status: 200, headers: { 'content-type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await ev(`window.showSettingsModal('notifications'); true`);
            await waitFor(`!!document.querySelector('#settings-inbox-teams .settings-inbox-except > summary')`, tag + ': the teams are drawn', 8000);
            await ev(`document.querySelectorAll('#settings-pane-notifications details.sv-advanced').forEach(d => { d.open = true; }); true`); // the teams sit under the pane's Advanced (ST5)
            const sum = () => ev(`document.querySelector('#settings-inbox-teams .settings-inbox-except > summary').textContent.replace(/\\s+/g, ' ').trim()`);
            const state = () => ev(`(() => { const d = document.querySelector('#settings-inbox-teams .settings-inbox-except'); return { open: d.open, shown: [...d.querySelectorAll('input[data-team]')].filter(b => b.checkVisibility({ contentVisibilityAuto: true })).length }; })()`);
            assert.equal(await sum(), 'All teams · Except…', tag + ': every team is in, and the line says so');
            const st = await state(); assert.deepEqual(st, { open: false, shown: 0 }, tag + ': five tick boxes are not on the page until Except… is opened: ' + JSON.stringify(st));
            await ev(`document.querySelector('#settings-inbox-teams .settings-inbox-except > summary').click(); true`); await nextFrame(ev); await nextFrame(ev);
            assert.equal((await state()).shown, 5, tag + ': opened, every team has its box');
            await ev(`document.querySelector('#settings-inbox-teams input[data-team="beta"]').click(); true`);
            assert.equal(await sum(), 'All teams except beta · Except…', tag + ': a team taken out is named in the line');
            await ev(`for (const t of ['gamma', 'delta', 'epsilon']) document.querySelector('#settings-inbox-teams input[data-team="' + t + '"]').click(); true`);
            assert.equal(await sum(), 'All teams except 4 · Except…', tag + ': more than three are counted');
            const saved = await ev(`import((window.__coralStatic || '/static/') + 'settings_inbox.js').then(m => m.readInboxSettings({}).inbox_included_teams)`);
            assert.equal(saved, '["alpha"]', tag + ': what is saved is still the list of included teams');
            await ev(`for (const t of ['beta', 'gamma', 'delta', 'epsilon']) document.querySelector('#settings-inbox-teams input[data-team="' + t + '"]').click(); true`);
            assert.equal(await sum(), 'All teams · Except…', tag + ': every team put back is All teams again');
            assert.equal(await ev(`import((window.__coralStatic || '/static/') + 'settings_inbox.js').then(m => m.readInboxSettings({}).inbox_included_teams)`), 'all', tag + ': and that saves "all"');
        }
        console.log('PASS the Inbox teams are one "All teams" line with an Except… picker');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
