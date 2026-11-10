// "Add files" on a team's Artifacts tab and on a goal's page (#15317, walk 20 H1): the Operator gives the TEAM a file from the dashboard. One visible, labelled button (not a small + beside the search box); a file of
// any type is stored as the Operator's artifact on the team, ONE board message tells the team its coral:// id, and a file added from a goal's page lands on that goal (its Artifacts tab lists it, the message names the goal
// by number). The reply box's Add image button says before a file is picked that it takes pictures only. Real board on the isolated dev server (removed again). Drives Chrome over CDP; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'taf-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const choose = (rootSel, files) => ev(`(() => { const dt = new DataTransfer(); for (const [n, text] of ${JSON.stringify(files)}) dt.items.add(new File([text], n)); const i = document.querySelector(${JSON.stringify(rootSel)} + ' input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const messages = async () => { const r = await api('GET', `/api/board/${B}/messages/all?limit=200`); const b = r.body; return (Array.isArray(b) ? b : (b && b.messages) || []).map(m => m.content || m.body || ''); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await load('/');
        const sub = await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'claude-11111111-2222-3333-4444-555555555555' });
        assert.ok(sub.status < 300, JSON.stringify(sub));
        const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Ship it', outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g));
        const G = g.body.id;
        assert.equal((await api('PATCH', `/api/board/${B}/goals/${G}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);

        console.log('1. The team Artifacts tab has one visible Add files button');
        await load(`/team/${B}/artifacts`);
        await waitFor(`!!document.querySelector('.share-drop-add')`, 'the Add files button', 15000);
        const ui = await ev(`(() => { const b = document.querySelector('.share-drop-add'), r = b.getBoundingClientRect(); return { text: b.textContent.trim(), shown: r.width > 0 && r.height > 0, icon: !!b.querySelector('.material-icons') }; })()`);
        assert.equal(ui.text.replace(/^add\s*/, ''), 'Add files'); assert.equal(ui.shown, true, 'visible, not hidden behind a menu');
        console.log('   ✓');

        console.log('2. A .md file is stored for the team and the team is told once');
        await choose('.share-drop-team', [['brief.md', '# the brief']]);
        await waitFor(`/^Shared a file with the team\\./.test(document.querySelector('.share-drop-team .share-drop-status')?.textContent || '')`, 'shared with the team', 15000);
        await waitFor(`[...document.querySelectorAll('tbody tr')].some(r => /brief\\.md/.test(r.textContent))`, 'brief.md in the list', 15000);
        const all = await messages(); const told = all.filter(m => /shared a file with the team/.test(m)); if (!told.length) console.log('MESSAGES', JSON.stringify(all).slice(0, 300), await ev(`document.querySelector('.share-drop-team .share-drop-status').textContent`));
        assert.equal(told.length, 1, JSON.stringify(told)); assert.match(told[0], /coral:\/\/artifacts\/[0-9a-f]{64}/); assert.doesNotMatch(told[0], /goal #/);
        console.log('   ✓');

        console.log('3. On a goal page: Add files lands the file on that goal and the message names the goal');
        await load(`/team/${B}/goals/${G}`);
        await waitFor(`!!document.querySelector('#team-panel-goals #goal-tab-artifacts')`, 'the Artifacts tab', 15000);
        await ev(`document.querySelector('#team-panel-goals #goal-tab-artifacts').click(); true`);
        await waitFor(`!!document.querySelector('#team-panel-goals .share-drop-add')`, 'the goal page Add files', 15000);
        await choose('#team-panel-goals .goal-artifacts-host', [['spec.txt', 'the spec']]);
        await waitFor(`[...document.querySelectorAll('#team-panel-goals .goal-list [data-artifact-id]')].some(r => /spec\\.txt/.test(r.textContent))`, 'spec.txt on the goal', 15000);
        const goalMsg = (await messages()).filter(m => /shared a file with the team/.test(m) && /spec\.txt/.test(m));
        assert.equal(goalMsg.length, 1); assert.match(goalMsg[0], new RegExp(`It is for goal #${G}\\.`));
        const onGoal = await api('GET', `/api/board/${B}/artifacts?goal=${G}`);
        assert.deepEqual(onGoal.body.artifacts.map(a => a.name), ['spec.txt'], 'only the goal\'s file');
        console.log('   ✓');

        console.log('4. The reply box\'s Add image button says pictures only before a file is picked');
        const tip = await ev(`(async () => { const m = await import(${S} + 'artifact_comment_images.js'); const t = m.createImageTray({ upload: async () => ({}) }); return t.picker().querySelector('button').title; })()`);
        assert.match(tip, /Pictures only: PNG, JPEG or WebP/); assert.match(tip, /Add files on the Artifacts tab/);
        console.log('   ✓');
        console.log('PASS team add files: a visible button, any file type, the team told once, a goal\'s file on the goal, and pictures-only said up front');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
