// The Files line that names the followed worktree belongs to the agent (and computer) it was read for (#12690, UI Reviewer's MUST): opening another agent never shows the last one's worktree, a late answer
// for the agent that was open before is ignored, and a read that fails takes the worktree off the line. Two agents (wa follows a worktree, wb has none), the files answers stubbed in the page, 1280 and 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const line = () => ev(`(() => { const e = document.getElementById('files-where'); return { text: e ? e.innerText : '', hidden: !e || e.hidden, back: !!document.querySelector('#files-where [data-on-click="worktree-launch"]') }; })()`);
    const pick = async (name, sid) => { await ev(`window.selectLiveSession('${name}', 'claude', '${sid}', 'local'); true`); await waitFor(`!!document.querySelector('#agentic-panel-files')`, 'the panel', 8000); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const tag = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__gate = { wa: null, wbFail: false };
                (() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const p = new URL(String(u), location.href).pathname, m = p.match(/\\/api\\/sessions\\/live\\/(wa|wb)\\/files(\\/refresh)?$/);
                        if (!m) return R(u, o);
                        if (m[1] === 'wa' && m[2] && window.__gate.waRefresh) return window.__gate.waRefresh.then(() => json({ error: 'boom' }, 500)); // A's refresh fails after a wait
                        if (m[1] === 'wa') { const answer = () => json({ files: [{ filepath: 'a.txt', status: 'added', additions: 1, deletions: 0 }], is_git: true, compare: { label: 'HEAD' }, worktree: { path: '/work/a-tree', name: 'a-tree', branch: 'feat-a', followed: true, launch: '/work/a' } });
                            return window.__gate.wa ? window.__gate.wa.then(answer) : answer(); }
                        if (window.__gate.wbFail) return json({ error: 'boom' }, 500);
                        return json({ files: [{ filepath: 'b.txt', status: 'added', additions: 1, deletions: 0 }], is_git: true, compare: { label: 'HEAD' }, worktree: null }); }; })();
                window.__m.add('wa', 'A', 3, { sleeping: false, session_id: 'wa-id', working_directory: '/work/a', branch: 'feat-a' }); window.__m.add('wb', 'A', 3, { sleeping: false, session_id: 'wb-id', working_directory: '/work/b', branch: 'main' }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the first live list renders from several answers; no single completion event
            await pick('wa', 'wa-id');
            await ev(`window.switchAgenticTab && window.switchAgenticTab('files', 'top'); window.toggleAgenticPanel && window.toggleAgenticPanel(true); window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!!document.querySelector('#files-where [data-on-click="worktree-launch"]')`, `${tag}: wa follows its worktree`, 8000);

            // 1) open the other agent: the last one's worktree is gone at once, while the other's own read is still to come
            await ev(`window.__gate.wa = null; true`);
            await pick('wb', 'wb-id');
            let l = await line();
            check(`${tag}: after A, B's line does not name A's worktree`, !/a-tree/.test(l.text) && !l.back, JSON.stringify(l));
            await ev(`window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-item[data-filepath="b.txt"]')`, `${tag}: B's files`, 8000);
            l = await line();
            check(`${tag}: B's own line has no worktree`, !/a-tree/.test(l.text) && !l.back, JSON.stringify(l));

            // 2) a late answer for A while B is open is ignored
            await pick('wa', 'wa-id');
            await ev(`window.__gate.wa = new Promise(r => { window.__release = r; }); window.refreshChangedFiles(); true`);
            await pick('wb', 'wb-id');
            await ev(`window.__release(); true`);
            await new Promise(r => setTimeout(r, 500)); // sleep-ok: the late answer has no event to wait for; it must change nothing
            l = await line();
            check(`${tag}: A's late answer does not put A's worktree on B's line`, !/a-tree/.test(l.text) && !l.back, JSON.stringify(l));
            check(`${tag}: and B's list stays B's`, JSON.stringify(await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath)`)) === '["b.txt"]');

            // 4) A's refresh is slow and then FAILS while B is open: the read A falls back to (it answers with a worktree) is not for the open agent, so it draws nothing on B
            await pick('wa', 'wa-id');
            await ev(`window.__gate.waRefresh = new Promise(r => { window.__releaseRefresh = r; }); window.refreshChangedFiles(); true`);
            await pick('wb', 'wb-id');
            await ev(`window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!!document.querySelector('#changed-files-list .file-item[data-filepath="b.txt"]')`, `${tag}: B's files`, 8000);
            await ev(`window.__releaseRefresh(); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: A's failed refresh and its fallback read have no event to wait for; they must change nothing
            l = await line();
            check(`${tag}: A's failed refresh and its fallback read do not put A's worktree on B's line`, !/a-tree/.test(l.text) && !l.back, JSON.stringify(l));
            check(`${tag}: and B's list stays B's after A's fallback read`, JSON.stringify(await ev(`[...document.querySelectorAll('#changed-files-list .file-item')].map(r => r.dataset.filepath)`)) === '["b.txt"]');
            await ev(`window.__gate.waRefresh = null; true`);

            // 3) A's worktree, then A's read fails: the worktree is off the line
            await ev(`window.__gate.wa = null; true`);
            await pick('wa', 'wa-id');
            await ev(`window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!!document.querySelector('#files-where [data-on-click="worktree-launch"]')`, `${tag}: A follows again`, 8000);
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => /\\/live\\/wa\\/files/.test(String(u)) ? Promise.resolve(new Response('{}', { status: 500 })) : R(u, o); return true; })()`);
            await ev(`window.refreshChangedFiles().then(() => true)`);
            await waitFor(`!document.querySelector('#files-where [data-on-click="worktree-launch"]')`, `${tag}: a failed read takes the worktree off the line`, 8000);
            check(`${tag}: the failed read leaves no worktree name`, !/a-tree/.test((await line()).text), JSON.stringify(await line()));
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the followed worktree line and the open agent:\n  ' + problems.join('\n  '));
    console.log('PASS the Files worktree line follows the open agent: switch, late answer and failed read');
})().catch(e => { console.error(e); process.exit(1); });
