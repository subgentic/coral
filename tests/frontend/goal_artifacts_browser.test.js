// A goal's Artifacts (#8592, Goal #61): a closed disclosure "Artifacts (N)" under the goal, nothing for a goal with none; open, the goal's files grouped by task ("#N Title, 2 files"), the first 20 and Load more for
// the rest; a name opens the preview, Details the sheet. Real board and goal on the isolated dev server (removed again); the section is mounted on a host element (the goal view's own mount is #8571's).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ga-' + Date.now().toString(36);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const S = `(window.__coralStatic || '/static/')`;
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const goal = async title => { const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title, outcome: 'o', done_when: 'd' }); assert.equal(g.status, 201, JSON.stringify(g)); return g.body.id; };
        const G = await goal('Ship it'), EMPTY = await goal('Nothing yet');
        const done = async (title, arts, goalId) => { const t = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'medium', goal_id: goalId }); assert.ok(t.status < 300, JSON.stringify(t)); const id = t.body.id;
            assert.ok((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'be', task_id: id })).status < 300);
            const r = await api('POST', `/api/board/${B}/tasks/${id}/complete`, { subscriber_id: 'be', message: 'done', outcome: 'success', artifacts: arts }); assert.ok(r.status < 300, JSON.stringify(r)); return id; };
        const a = await done('Write the report', [{ name: 'report.md', content: '# Report' }, { name: 'notes.txt', content: 'notes' }], G);
        const many = []; for (let i = 0; i < 21; i++) many.push({ name: `shot-${String(i).padStart(2, '0')}.txt`, content: 'x' + i });
        const b = await done('Take the screenshots', many, G);
        await done('Unrelated', [{ name: 'other.md', content: 'o' }], null);
        await ev(`import(${S} + 'state.js').then(m => { m.state.selectedTeam = ${JSON.stringify(B)}; return true; })`); // the team page's: the preview opens from a selected team
        const mount = id => ev(`(async () => { const m = await import(${S} + 'goal_artifacts.js'); let h = document.getElementById('ga-host'); if (h) h.remove(); h = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'ga-host' })); window.__ga = m.mountGoalArtifacts(h, { team: ${JSON.stringify(B)}, goalId: ${id} }); return true; })()`);

        console.log('1. A goal with none draws nothing');
        await mount(EMPTY);
        await waitFor(`document.querySelector('#ga-host .goal-artifacts') !== null`, 'the section is built', 5000);
        await waitFor(`document.querySelector('#ga-host .goal-artifacts').hidden === true`, 'no section for no files', 8000);
        console.log('   ✓');

        console.log('2. A goal with files: a closed disclosure with the count');
        await mount(G);
        await waitFor(`!document.querySelector('#ga-host .goal-artifacts').hidden && document.querySelector('#ga-host summary').textContent === 'Artifacts (23)'`, 'Artifacts (23)', 8000);
        assert.equal(await ev(`document.querySelector('#ga-host .goal-artifacts').open`), false, 'closed to begin with');
        assert.equal(await ev(`document.querySelectorAll('#ga-host tbody tr').length`), 0, 'nothing read until it opens');
        console.log('   ✓');

        await shot('goal-artifacts-closed');
        console.log('3. Open: grouped by task, the first 20, Load more');
        await ev(`document.querySelector('#ga-host summary').click(); true`);
        await waitFor(`document.querySelectorAll('#ga-host [data-artifact-id]').length >= 1`, 'rows', 10000).catch(async e => { throw new Error(e.message + ' ' + await ev(`document.getElementById('ga-host').innerText.slice(0, 300)`)); });
        assert.equal(await ev(`document.querySelectorAll('#ga-host [data-artifact-id]').length`), 20, 'the first 20');
        const heads = await ev(`[...document.querySelectorAll('#ga-host tr.dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.ok(heads.some(h => h === `#${b} Take the screenshots`), 'with more to load a head is the task alone: ' + JSON.stringify(heads));
        assert.equal(new Set(heads).size, heads.length, 'a task\'s head is drawn once: ' + JSON.stringify(heads));
        assert.equal(await ev(`/Showing 20 of 23/.test(document.getElementById('ga-host').textContent)`), true);
        await ev(`document.querySelector('#ga-host .dt-more').click(); true`);
        await waitFor(`document.querySelectorAll('#ga-host [data-artifact-id]').length === 23`, 'all 23', 10000);
        const all = await ev(`[...document.querySelectorAll('#ga-host tr.dt-group')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
        assert.equal(all.length, 2, JSON.stringify(all)); assert.ok(all.some(h => h.includes(`#${b} Take the screenshots, 21 files`)), JSON.stringify(all)); assert.ok(all.some(h => h.includes(`#${a} Write the report, 2 files`)), JSON.stringify(all));
        assert.equal(await ev(`document.getElementById('ga-host').textContent.includes('other.md')`), false, 'only this goal\'s files');
        console.log('   ✓');

        await shot('goal-artifacts-open');
        console.log('4. A name opens the document in the detail pane (a team page); no Details link beside it');
        await ev(`[...document.querySelectorAll('#ga-host [data-artifact-id]')].find(b => b.textContent === 'report.md').click(); true`);
        await waitFor(`[...document.querySelectorAll('button, a')].some(b => b.textContent === 'Copy link')`, 'the detail pane', 10000);
        await waitFor(`document.body.textContent.includes('Report')`, 'the document in it', 10000);
        assert.equal(await ev(`document.querySelectorAll('#ga-host .artifact-details').length`), 0, 'the pane is the sheet: no second link');
        console.log('   ✓');
        await shot('goal-artifacts-document');
        console.log('PASS goal artifacts: closed with a count, grouped by task, paged, preview and sheet');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
