// A task row says how many artifacts its results reference (#8575, goal #61): a quiet "3 files" button on the row's meta line (the page icon and the count, 12/400, named "3 artifacts, open"),
// nothing for a task with none; pressed, it opens the task and brings its Artifacts section to the top, focused. The count is the server's artifact_count on the list item (stood in at the page's list
// read), the section's own read is stubbed. Real board on the isolated dev server (removed again); the team Tasks tab at 1280, folded at 390 px: the button is a 44 px target there without a taller row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const HEX = 'c'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'files-' + Date.now().toString(36);
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // the list read says artifact_count for two of the three tasks; the section's read answers one artifact per task asked for
    const STUB = counts => `(() => { const real = window.fetch; window.__counts = ${JSON.stringify(counts)};
        window.fetch = async (u, o) => { const url = new URL(String(u && u.url || u), location.origin);
            if (/\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && url.searchParams.has('task')) { const id = Number(url.searchParams.get('task'));
                return new Response(JSON.stringify({ total: 1, artifacts: [{ id: ${JSON.stringify(HEX)}, name: 'report.md', media_type: 'text/markdown', size: 10, created_at: new Date().toISOString(), task_id: id, uri: 'coral://artifacts/${HEX}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
            const r = await real(u, o);
            if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(url.pathname) && r.ok) { const d = await r.clone().json().catch(() => null); if (d && Array.isArray(d.tasks)) { for (const t of d.tasks) if (window.__counts[t.id] !== undefined) t.artifact_count = window.__counts[t.id]; return new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } }); } }
            return r; }; return true; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        for (const [sid, jt] of [['orch', 'Orchestrator'], ['be', 'Backend Dev']]) assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: sid, job_title: jt, session_name: sid + '-s' })).status < 300);
        const ids = [];
        for (const title of ['Write the report', 'A task with nothing attached', 'Draw the diagram']) { const m = await api('POST', `/api/board/${B}/tasks`, { title, body: 'x', assigned_to: 'be', created_by: 'orch', priority: 'high' }); assert.ok(m.status < 300, JSON.stringify(m)); ids.push(m.body.id); }
        const counts = { [ids[0]]: 3, [ids[2]]: 1 };
        await Page.addScriptToEvaluateOnNewDocument({ source: STUB(counts) });

        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks' }); true`);
            await waitFor(`document.querySelectorAll('#team-panel-tasks tbody tr').length === 3`, 'the three tasks', 15000);

            console.log(`${at}the count on the rows that have artifacts`);
            const rows = await ev(`[...document.querySelectorAll('#team-panel-tasks tbody tr')].map(r => { const b = r.querySelector('button.dt-files'); return { title: r.querySelector('.dt-primary').textContent, files: b ? { text: b.textContent.replace('description', '').trim(), name: b.getAttribute('aria-label'), icon: b.querySelector('.material-icons').getAttribute('aria-hidden') } : null }; })`);
            const by = Object.fromEntries(rows.map(r => [r.title, r.files]));
            assert.deepEqual(by['Write the report'], { text: '3 files', name: '3 artifacts, open', icon: 'true' }, at + JSON.stringify(rows));
            assert.deepEqual(by['Draw the diagram'], { text: '1 file', name: '1 artifact, open', icon: 'true' });
            assert.equal(by['A task with nothing attached'], null, at + 'no count for a task with none');
            const g = await ev(`(() => { const b = document.querySelector('#team-panel-tasks button.dt-files'), cs = getComputedStyle(b), r = b.getBoundingClientRect(), tr = b.closest('tr').getBoundingClientRect(), pe = getComputedStyle(b, '::after'); return { size: cs.fontSize, weight: cs.fontWeight, h: Math.round(tr.height), hit: [parseFloat(pe.width), parseFloat(pe.height)], inRow: r.right <= tr.right + 1 && r.left >= tr.left - 1, wide: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.equal(g.size, '12px'); assert.equal(g.weight, '400'); assert.ok(g.inRow && g.wide, at + JSON.stringify(g));
            if (mobile) { assert.ok(g.hit[0] >= 44 && g.hit[1] >= 44, at + 'its 44 px target: ' + JSON.stringify(g)); assert.ok(g.h <= 80, at + 'a folded row stays compact: ' + g.h); }
            await shot(`task-files-${w}`);

            console.log(`${at}pressed: the task opens at its Artifacts section, focused`);
            await ev(`document.querySelector('#team-panel-tasks button.dt-files').click(); true`);
            await waitFor(`!!document.querySelector('#team-panel-item #team-task-title') && !!document.getElementById('team-task-artifacts-head-${ids[0]}')`, 'the task page and its Artifacts', 15000);
            await waitFor(`document.activeElement && document.activeElement.id === 'team-task-artifacts-head-${ids[0]}'`, 'the focus on the Artifacts heading', 8000);
            assert.match(await ev(`document.getElementById('team-task-title').textContent`), /Write the report$/);
            await shot(`task-files-open-${w}`);
        }
        console.log('PASS task files count: the count on the rows that have artifacts, opening the task at its Artifacts section');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
