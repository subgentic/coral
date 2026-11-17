// #17675 (walk 79): saving Additional instructions says when they take effect (at each agent's next task), not the working mode's line; saving the mode says the mode's.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const TEAM = 'instr-note-' + Date.now();
    const api = (path, opts) => ev(`fetch('/api/board/${TEAM}${path}', ${JSON.stringify(opts || {})}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const put = (path, body) => api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const form = `document.querySelector('#team-settings-workspace')`;
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
        const sub = await api('/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Boss', job_title: 'Orchestrator', session_name: 'boss-session' }) });
        assert.ok(sub.status < 300, JSON.stringify(sub));
        assert.equal((await put('/working-mode', { mode: 'none', dependency_guidance: false, custom_instructions: 'as the dialog opens' })).status, 200);

        const open = async () => {
            // The previous dialog goes now, before the import resolves, so the wait below can only see the new one (it
            // otherwise passed on the old dialog, which the new one then replaced under the next click).
            await ev(`document.getElementById('team-settings-workspace')?.remove(); import((window.__coralStatic || '/static/') + 'team_working_mode.js').then(m => m.showTeamWorkingMode(${JSON.stringify(TEAM)}, { page: (document.getElementById('qa-ts-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]') && !!document.querySelector('#team-settings-workspace .settings-tab[data-section=health]')`, 'the loaded Team settings', 15000);
        };
        const submit = async () => {
            await ev(`document.querySelector('#team-settings-workspace .sv-save').click(); true`);
            await waitFor(`/Saved|Could not/.test(document.querySelector('#team-settings-workspace .sv-status').textContent)`, 'the save', 10000);
            assert.match(await ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`), /^Saved/);
        };

        const status = () => ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`);
        console.log('1. Only the instructions changed: the note says when they reach the agents, and does not talk about the working mode');
        await open();
        await ev(`(() => { const t = ${form}.querySelector('[name=custom_instructions]'); t.value = 'Always cite the source.'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
        await submit();
        const note = await status();
        assert.match(note, /^Saved\. Additional instructions reach each agent with the next task it claims\./, `the note names the instructions: ${note}`);
        assert.doesNotMatch(note, /Working mode/, `a saved instruction is not a working-mode change: ${note}`);
        console.log('2. Only the working mode changed: the note is the mode\'s');
        await open();
        await ev(`const c = ${form}.querySelector('[name=dependency_guidance]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); true`);
        await submit();
        const note2 = await status();
        assert.match(note2, /^Saved\. Working mode applies to tasks agents claim from now on[;.]/, note2);
        assert.doesNotMatch(note2, /Additional instructions/, note2);
        console.log('PASS the save note names what was saved');
    } finally {
        await removeBoards(ev, [TEAM]);
        try { await client.close(); } catch (_) {}
    }
})().catch(error => { console.error(error); process.exit(1); });
