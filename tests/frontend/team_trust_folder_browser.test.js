// New team trusts the folder (#11889, the Operator's decision, Security's conditions): a folder Coral makes says "Coral will start these agents in this folder and trust it for them."; an existing folder shows
// a "Trust this folder" switch, off, that names the path, and only a ticked one sends trust_folder. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { removeBoards } = require('./helpers/board_cleanup');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`(async () => { window.__teamLaunches = [];
            const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                if (p.pathname === '/api/sessions/launch-team' && m === 'POST') { window.__teamLaunches.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }] }); }
                if (p.pathname === '/api/filesystem/list') { window.__listed = (window.__listed || 0) + 1; return p.searchParams.get('path') === '/home/p/Coral/exists' ? json({ entries: [] }) : json({ error: 'not found' }, 404); }
                if (p.pathname === '/api/board/projects') return json([]);
                return real(u, o); };
            await window.showLaunchModal(); window.hideLaunchModal(); })(); true`);
        const open = async () => {
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`!!document.getElementById('launch-step-team') && getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-template-select option').length > 1`, 'the team step');
        };
        const setDir = async (value, suggested) => {
            const before = await ev(`window.__listed || 0`);
            await ev(`{ const d = document.getElementById('launch-team-dir'); d.value = ${JSON.stringify(value)}; ${suggested ? `d.dataset.suggested = ${JSON.stringify(value)};` : `delete d.dataset.suggested;`} d.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            if (suggested) await waitFor(`(window.__listed || 0) > ${before}`, 'the folder was looked up');
            await ev(`new Promise(r => setTimeout(r, 120))`); // sleep-ok: the answer is applied in the next task
        };
        const rowHidden = id => ev(`(document.getElementById(${JSON.stringify(id)}) || document.getElementById('launch-team-trust-line'))?.closest('.sv-row')?.hidden`);
        const visible = id => ev(`{ const r = document.getElementById(${JSON.stringify(id)})?.closest('.sv-row'); !!r && !r.hidden }`);
        const go = async () => {
            await ev(`{ const n = document.getElementById('team-board-name'); n.value = 'trust-' + (window.__teamLaunches.length + 1); n.dispatchEvent(new Event('input', { bubbles: true })); } true`);
            await ev(`document.querySelector('#launch-team-next').click(); true`);
            await ev(`document.querySelector('#launch-team-next').click(); true`);
            const before = await ev(`window.__teamLaunches.length`);
            await ev(`document.querySelector('#launch-team-go').click(); true`);
            await waitFor(`window.__teamLaunches.length === ${before + 1}`, 'the launch request');
            return ev(`window.__teamLaunches[window.__teamLaunches.length - 1]`);
        };

        console.log('A folder Coral makes says it will trust it, and has no switch');
        await open(); await setDir('/home/p/Coral/proj', true);
        assert.equal(await visible('launch-team-trust-line'), true, 'the line shows');
        assert.equal(await ev(`document.getElementById('launch-team-trust-line').textContent`), 'Coral will start these agents in this folder and trust it for them.');
        assert.equal(await visible('launch-team-trust'), false, 'no switch for a folder Coral makes');
        let sent = await go();
        assert.equal(sent.create_dir, true); assert.equal(sent.trust_folder, undefined, 'the made folder is trusted by the server, not asked for');
        await ev(`window.hideLaunchModal(); true`);

        console.log('An existing folder shows the switch, off, naming the path; unticked sends nothing, ticked sends trust_folder');
        await open(); await setDir('/home/p/Code/app', false);
        assert.equal(await visible('launch-team-trust'), true, 'the switch shows');
        assert.equal(await visible('launch-team-trust-line'), false, 'and the line does not');
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`), false, 'off by default');
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /Trust this folder: its settings and tools can run/);
        assert.match(await ev(`document.getElementById('launch-team-trust').closest('.sv-row').textContent`), /\/home\/p\/Code\/app/, 'it names the path');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'unticked: nothing'); assert.equal(sent.create_dir, undefined);
        await ev(`window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        sent = await go();
        assert.equal(sent.trust_folder, true, 'ticked: the request says so');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A suggested folder that is already there is not made by Coral: no line, the switch shows, and only a tick trusts it');
        await open(); await setDir('/home/p/Coral/exists', true);
        assert.equal(await visible('launch-team-trust-line'), false, 'the line "Coral will ... trust it for them" is gone');
        assert.equal(await visible('launch-team-trust'), true, 'the switch shows for it');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'unticked: nothing is trusted');
        await ev(`window.hideLaunchModal(); true`);
        await open(); await setDir('/home/p/Coral/exists', true);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        sent = await go();
        assert.equal(sent.trust_folder, true, 'ticked: trusted');
        await ev(`window.hideLaunchModal(); true`);

        console.log('A tick for one folder is gone when the folder is another, even when the dialog is opened again');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await setDir('/home/p/Code/other', false);
        assert.equal(await ev(`document.getElementById('launch-team-trust').checked`), false, 'the switch went back to off for the other folder');
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'and nothing is trusted');
        await ev(`window.hideLaunchModal(); true`);

        console.log('Changing the folder to one Coral makes takes the switch away and does not send a stale tick');
        await open(); await setDir('/home/p/Code/app', false);
        await ev(`document.getElementById('launch-team-trust').click(); true`);
        await setDir('/home/p/Coral/proj2', true);
        assert.equal(await visible('launch-team-trust'), false);
        sent = await go();
        assert.equal(sent.trust_folder, undefined, 'a tick for another folder is not sent'); assert.equal(sent.create_dir, true);
    } finally { await removeBoards(ev, Array.from({ length: 12 }, (_, i) => 'trust-' + (i + 1))); await client.close(); }
    console.log('team_trust_folder_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
