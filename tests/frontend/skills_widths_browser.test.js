// Skills table widths (#15839, design K2): the name column gets the free width first, so a 30-letter name shows whole at 1440 and 1920, and the description takes what is left, so no empty band is left at the right of the table.
// The routes are stood in at /api/skills. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const mk = (i, name, description, status = 'approved') => ({ id: String(i).repeat(32), name, version: 1, digest: String(i).repeat(64), description, status, has_scripts: false, not_reviewable: false, publisher_kind: 'agent', publisher_agent: 'Backend Dev', publisher_team: 'alpha', file_count: 1, created_at: '2026-11-02T10:00:00Z', decided_at: '2026-11-02T10:00:00Z' });
const ROWS = [
    mk(1, 'working-in-a-coral-team-with-tools', 'Use this when you work in a Coral team: how to read the board, claim a task, post a summary and ask the Operator for a decision.'),
    mk(2, 'release-notes', 'Writes release notes from the merged pull requests of a milestone, grouped by area, with one line each.'),
    mk(3, 'db-review', 'Checks a SQL migration for locks, missing indexes and irreversible changes before it runs.', 'pending'),
];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1440, 1920, 1024]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`(() => { const rows = ${JSON.stringify(ROWS)}; const R = window.fetch;
                window.fetch = (u, o = {}) => { const p = new URL(String(u && u.url || u), location.origin).pathname; if (p === '/api/skills') return Promise.resolve(new Response(JSON.stringify({ skills: rows }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); }; return true; })()`);
            await ev(`window.switchNavTab('skills'); true`);
            await waitFor(`document.querySelectorAll('#skills-view tr.dt-row').length === 3`, `${w}: three skills`, 8000);
            await settle(600); // the table sizes its columns after the rows are drawn
            const m = await ev(`(() => { const box = document.querySelector('#skills-view .dt-box, #skills-view .dt-scroll') || document.querySelector('#skills-view table').parentElement; const t = document.querySelector('#skills-view table');
                const cut = k => [...document.querySelectorAll('#skills-view td.dt-td[data-key="' + k + '"]')].map(td => { const n = [td, ...td.querySelectorAll('*')].find(x => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflow !== 'visible'); return !!n; });
                const th = [...document.querySelectorAll('#skills-view th.dt-th')].filter(x => x.getClientRects().length); const last = th[th.length - 1].getBoundingClientRect(), tr = t.getBoundingClientRect(), br = box.getBoundingClientRect();
                return { nameCut: cut('name'), descShown: !!document.querySelector('#skills-view th.dt-th[data-key="description"]') && document.querySelector('#skills-view th.dt-th[data-key="description"]').getClientRects().length > 0, descCut: cut('description'), gap: Math.round(br.right - last.right), table: Math.round(tr.width), box: Math.round(br.width), side: document.getElementById('skills-view').scrollWidth <= document.getElementById('skills-view').clientWidth + 1 }; })()`);
            if (w >= 1440) assert.deepEqual(m.nameCut, [false, false, false], `${w}: a 30-letter name shows whole: ` + JSON.stringify(m)); // at 1024 the box is 670 px and the description is dropped: the name gets what the other columns leave
            assert.ok(m.gap <= 2, `${w}: no empty band at the right of the table (${m.gap} px): ` + JSON.stringify(m));
            assert.equal(m.side, true, `${w}: no sideways scroll`);
            if (w >= 1440) assert.equal(m.descShown, true, `${w}: the description column is there: ` + JSON.stringify(m));
            if (w >= 1920) assert.deepEqual(m.descCut.filter(Boolean).length <= 1, true, `${w}: at most the longest description is cut: ` + JSON.stringify(m));
            const d = process.env.CORAL_SCREENSHOT_DIR; if (d) { require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/skills-widths-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
        console.log('skills widths ok');
    } finally { try { client.close(); } catch (_) {} }
})().catch(e => { console.error(e); process.exit(1); });
