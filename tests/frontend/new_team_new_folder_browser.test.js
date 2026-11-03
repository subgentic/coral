// The New team wizard and a folder that does not exist yet (#12833, found by a first-time user): step 1 accepted a new folder and Launch team sent the person back to step 1 with "Folder not found". Now a folder the
// person typed or browsed to that does not exist yet, inside one that does, gets a line at step 1 that says Coral creates it when the team is launched, and Launch asks for exactly that (create_new_folder); a folder
// that exists, a name Coral would not make, a missing parent and a path with .. get no line and no request. At 1440 and 390 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(async () => { window.__reqs = [];
                const real = window.fetch; const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
                const there = new Set(['/work', '/work/existing', '/work/a/..']); // the last: a parent that a naive server answer would call there, so only the page's own check refuses a path with ..
                window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href), m = o.method || 'GET';
                    if (m === 'POST' && p.pathname === '/api/sessions/launch-team') { window.__reqs.push(JSON.parse(o.body)); return json({ agents: [{ name: 'A', session_id: 's' }] }); }
                    if (p.pathname === '/api/board/projects') return json([]);
                    if (p.pathname === '/api/filesystem/is-git') return json({ is_git: false });
                    if (p.pathname === '/api/filesystem/list') { const d = (p.searchParams.get('path') || '').replace(/\\/+$/, ''); return there.has(d) ? json({ entries: [] }) : json({ error: 'directory not found' }, 404); }
                    return real(u, o); };
                await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`);
            const fill = (id, v) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            const line = () => ev(`(() => { const l = document.getElementById('launch-team-dir-new'); return { shown: !!l && !l.hidden && l.getClientRects().length > 0, text: l ? l.textContent : '' }; })()`);
            const open = async dir => {
                await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
                await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
                await fill('team-board-name', 'planner-shop');
                await fill('launch-team-dir', dir);
                await sleep(1100); // sleep-ok: the folder is checked 500 ms after the last keystroke, over two requests; nothing marks "no line will come"
            };
            const launch = async () => {
                const n0 = await ev(`window.__reqs.length`);
                await ev(`(() => { const e = [...document.querySelectorAll('#launch-step-team [data-on-click="m-launch-team"]')].find(x => x.getClientRects().length) || document.querySelector('#launch-step-team [data-on-click="m-launch-team"]'); e.click(); return true; })()`);
                await waitFor(`window.__reqs.length > ${n0}`, 'the team request', 8000);
                return ev(`window.__reqs[${n0}]`);
            };
            const close = () => ev(`window.hideLaunchModal(); true`);

            // a new folder inside one that exists: the line says so at step 1, and Launch asks for it
            await open('/work/planner-shop');
            let l = await line();
            check(`${tag}: a new folder inside an existing one: step 1 says Coral creates it when the team is launched`, l.shown && /planner-shop does not exist yet\. Coral creates it inside \/work when you launch the team\./.test(l.text), JSON.stringify(l));
            let body = await launch();
            check(`${tag}: Launch asks for it (create_new_folder) at the folder the person chose, and not as the suggestion`, body.working_dir === '/work/planner-shop' && body.create_new_folder === true && !body.create_dir, JSON.stringify({ d: body.working_dir, n: body.create_new_folder, c: body.create_dir }));
            await close();

            // the line goes when the field changes
            await open('/work/planner-shop');
            await ev(`(() => { const e = document.getElementById('launch-team-dir'); e.value = '/work/existing'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            check(`${tag}: the line goes the moment the folder is edited`, !(await line()).shown);
            await sleep(1100); // sleep-ok: the check after the edit
            check(`${tag}: an existing folder gets no line`, !(await line()).shown);
            body = await launch();
            check(`${tag}: and no request to make it`, body.working_dir === '/work/existing' && body.create_new_folder === undefined, JSON.stringify(body.create_new_folder));
            await close();

            // QA's SHOULDs: the mark that lets Launch ask is cleared on the first keystroke (before the folder is checked again), and another computer's folder is not offered the line
            await open('/work/planner-shop');
            check(`${tag}: before the edit the mark is set`, (await ev(`document.getElementById('launch-team-dir').dataset.createNew`)) === '/work/planner-shop');
            await ev(`(() => { const e = document.getElementById('launch-team-dir'); e.value = '/work/planner-shopx'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            check(`${tag}: the first keystroke clears the mark at once`, (await ev(`document.getElementById('launch-team-dir').dataset.createNew === undefined`)) === true);
            await close();
            await ev(`window.showLaunchModal(); window._selectLaunchType('team'); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none'`, 'the team step', 8000);
            await ev(`document.getElementById('launch-team-dir').dataset.dirServer = 'srv2'; true`); // the folder is another computer's
            await fill('team-board-name', 'planner-shop');
            await fill('launch-team-dir', '/work/planner-shop');
            await sleep(1100); // sleep-ok: the folder check is debounced; nothing marks "no line will come"
            check(`${tag}: another computer's folder is not offered the line`, !(await line()).shown && (await ev(`document.getElementById('launch-team-dir').dataset.createNew === undefined`)) === true);
            body = await launch();
            check(`${tag}: and Launch makes no request for it`, body.create_new_folder === undefined);
            await ev(`delete document.getElementById('launch-team-dir').dataset.dirServer; true`);
            await close();

            // what Coral would not make, and where it cannot: no line and no request
            for (const [why, dir] of [['a name with a space', '/work/has space'], ['a missing parent', '/nope/planner-shop'], ['a path with ..', '/work/a/../planner-shop'], ['two new levels', '/work/new/deeper']]) {
                await open(dir);
                check(`${tag}: ${why}: no line`, !(await line()).shown, dir);
                body = await launch();
                check(`${tag}: ${why}: no request to make a folder`, body.create_new_folder === undefined, dir);
                await close();
            }
        }
    } finally {
        // The wizard's first step creates the team's board ('planner-shop') on the real server as it is filled in, and nothing here launches a team, so it is left with its one subscriber: --fail-on-leak counts it (#12986). Delete it, whatever happened above.
        try { const r = await fetch(`${BASE}/api/board/planner-shop`, { method: 'DELETE' }); if (r.status >= 300 && r.status !== 404) console.log(`[WARN] could not delete the board planner-shop: ${r.status}`); } catch (e) { console.log(`[WARN] could not delete the board planner-shop: ${e.message}`); }
        await client.close();
    }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} new team folder checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
