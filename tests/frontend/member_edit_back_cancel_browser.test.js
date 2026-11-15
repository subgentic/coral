// Edit member inside New team (walk 80 item 11, #17726): the footer's Back from the member's settings opens its role and prompt with the member's own values (not a blank form with an empty required Role), and Cancel
// (and the header arrow) close only the member editor: the New team wizard stays open on its members with the team as typed. Real clicks on the dialog's own buttons; desktop and phone.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const open = async (w, mobile) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 800, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => {
                window.__reqs = [];
                const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (m === 'POST' && /^\\/api\\/sessions\\/(launch|launch-team|live\\/[^/]+\\/restart)$/.test(p.pathname)) { window.__reqs.push({ path: p.pathname, body: JSON.parse(o.body) }); return json({ session_name: 'x', session_id: 'sid', agents: [{ name: 'A', session_id: 's' }] }); }
                    if (p.pathname === '/api/board/projects') return json([{ project: 'taken' }]);
                    if (p.pathname === '/api/filesystem/is-git') return json({ is_git: true });
                    return real(u, o); };
                await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`);
        };
        const vis = sel => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`;
        const click = id => ev(`document.getElementById(${JSON.stringify(id)}).click(); true`);
        const state = () => ev(`(() => { const shown = e => !!e && !e.hidden && e.getClientRects().length > 0; const m = document.getElementById('launch-modal');
            return { modal: getComputedStyle(m).display !== 'none', member: m.dataset.member || '', stage: document.getElementById('launch-step-agent').dataset.stage, teamShown: shown(document.getElementById('launch-step-team')),
                role: document.getElementById('launch-agent-name-input').value, prompt: (document.querySelector('#launch-agent-acf .acf-prompt') || {}).value, rows: [...document.querySelectorAll('#team-agents-list .team-agent-role-name')].map(e => e.textContent) }; })()`);
        for (const [w, mobile, tag] of [[1440, false, 'desktop'], [390, true, 'phone']]) {
            await open(w, mobile);
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); window._addTeamAgent('Scribe', 'Write the notes.'); true`);
            await waitFor(`!!document.querySelector('#team-agents-list .team-agent-row')`, `${tag}: the member row`);
            const rowsNow = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-role-name')].map(e => e.textContent)`), before = await rowsNow();
            assert.ok(before.includes('Scribe'), `${tag}: the added member is a row: ` + before);
            const edit = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].find(r => r.querySelector('.team-agent-role-name').textContent === 'Scribe').querySelector('.team-agent-edit-btn').click(); true`);
            // Back from the settings: the role and the prompt are the member's own
            await edit(); await waitFor(`document.getElementById('launch-modal').dataset.member === 'edit' && document.getElementById('launch-step-agent').dataset.stage === 'agent'`, `${tag}: Edit member`);
            await click('launch-agent-back'); await waitFor(`document.getElementById('launch-step-agent').dataset.stage === 'persona'`, `${tag}: Back opens the role`);
            let s = await state();
            assert.equal(s.role, 'Scribe', `${tag}: Back shows the member's own Role, not an empty required field: ` + JSON.stringify(s));
            assert.equal(s.prompt, 'Write the notes.', `${tag}: and its prompt: ` + JSON.stringify(s));
            // Cancel closes the member editor only
            await click('launch-agent-cancel');
            await waitFor(`document.getElementById('launch-modal').dataset.member !== 'edit'`, `${tag}: the member editor closes`);
            s = await state();
            assert.ok(s.modal && s.teamShown, `${tag}: Cancel leaves the New team wizard open on its form: ` + JSON.stringify(s));
            assert.deepEqual(s.rows, before, `${tag}: and the typed team is kept: ` + JSON.stringify(s));
            // the header arrow does the same
            await edit(); await waitFor(`document.getElementById('launch-modal').dataset.member === 'edit'`, `${tag}: Edit member again`);
            await ev(`window._selectLaunchType('back'); true`);
            await waitFor(`document.getElementById('launch-modal').dataset.member !== 'edit'`, `${tag}: the arrow closes the member editor`);
            s = await state();
            assert.ok(s.modal && s.teamShown && s.rows.length === before.length, `${tag}: the arrow leaves the wizard and the team: ` + JSON.stringify(s));
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS Edit member: Back keeps the member\'s role, Cancel closes only the member editor');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
