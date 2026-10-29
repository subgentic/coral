// The team page's documents-only detail pane (#7453, stage 1; UI/UX's team page doc 7aa984fe): choosing an artifact row opens an aside named Details beside the table (460 px wide at 1500 px and over, a 56 px rail of the
// table below 1500 px, a sheet over a phone), with a heading, Open, Download, Copy link and a Close details button; Escape and Close details close it and give the focus back to the row, and the row is marked current
// while it is open. Bulk selection is a separate state. Goals, tasks and agents never open a pane (they get a page, or none); the header and the tab strip do not move when the pane opens. Written failing-first by QA (#7466): controls by role and
// accessible name (helpers/team_page.js). Isolated dev server; the artifact list is stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab, rect, scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const VIEWS = [['1600x900', 1600, 900, false], ['1280x800', 1280, 800, false], ['390x844', 390, 844, true]];
const TEAM = `qa-pane-${Date.now() % 100000}`;
const ART = 'Settings audit';
const HEX = 'a'.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const stub = () => ev(`(() => { const R = window.fetch.bind(window); const j = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname)) return j({ project: ${JSON.stringify(TEAM)}, artifacts: [{ id: ${JSON.stringify(HEX)}, name: ${JSON.stringify(ART)}, media_type: 'text/plain', size: 1200, task_id: 0, task_title: '', created_at: '2026-10-25T06:00:00Z', uri: 'coral://artifacts/${HEX}', available: true }], has_more: false });
            if (url.pathname === '/api/artifacts/${HEX}') return Promise.resolve(new Response('The settings audit text.', { headers: { 'Content-Type': 'text/plain' } }));
            return R(u, o); };
        return true; })()`);
    const row = rx => `(() => { const e = window.__tp.find('button, a, [role=row], tr', ${rx}); return e; })()`;
    const paneBox = () => ev(`(() => { const p = window.__tp.pane(); return p ? window.__na.box(p) : null; })()`);
    const openRow = async () => { assert.ok(await ev(`(() => { const e = ${row('/' + ART + '/')}; if (!e) return false; e.focus(); e.click(); return true; })()`), `no row named ${ART}`); await settle(400); };
    const closeRow = async () => { await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`); await settle(300); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of VIEWS) {
            console.log(label);
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM); await stub();
            if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await S.run(`${label}: an artifact row opens the aside named Details with a heading, Open, Download, Copy link and Close details`, async () => {
                await goTab(ev, settle, 'Artifacts');
                assert.equal(await paneBox(), null, 'no pane before a row is chosen');
                await openRow();
                const p = await ev(`(() => { const a = window.__tp.pane(); if (!a) return null; const names = [...a.querySelectorAll('button, a')].filter(window.__na.vis).map(window.__na.name); const hd = a.querySelector('h2'); return { heading: hd ? window.__na.text(hd) : '', names }; })()`);
                assert.ok(p, 'an aside named Details is open');
                assert.ok(p.heading.includes(ART), `its h2 names the artifact (got ${JSON.stringify(p.heading)})`);
                for (const n of ['Close details', 'Open', 'Download', 'Copy link']) assert.ok(p.names.some(x => x === n || x.startsWith(n)), `a control named ${n} (got ${JSON.stringify(p.names)})`);
                assert.ok(await ev(`/The settings audit text\\./.test(window.__na.text(window.__tp.pane()))`), 'the pane shows the artifact text');
            });
            await S.run(`${label}: the pane is ${mobile ? 'a sheet over the page' : (w >= 1500 ? '460 px wide' : 'beside the sidebar as a 56 px rail')}`, async () => {
                const b = await paneBox(); assert.ok(b, 'the pane is open');
                if (mobile) assert.ok(b.w >= w - 2 && b.h >= h * 0.6, `a sheet over a phone (pane ${b.w}x${b.h} in ${w}x${h})`);
                else if (w >= 1500) assert.ok(Math.abs(b.w - 460) <= 1, `460 px wide (got ${b.w})`);
                else {
                    // UI/UX's doc: below 1500 px the LEFT SIDEBAR is the 56 px rail while the pane is open, and the page keeps the rest of the width (the table is not the rail).
                    const sb = await ev(`(() => { const a = window.__tp.sidebar(); return a ? Math.round(a.getBoundingClientRect().width) : null; })()`);
                    assert.ok(sb !== null && sb <= 58 && sb >= 54, `the sidebar is a 56 px rail (got ${sb})`);
                    const tw = await ev(`(() => { const t = [...window.__tp.page().querySelectorAll('table, [role=table], [role=grid]')].find(x => x.getClientRects().length); return t ? Math.round(t.getBoundingClientRect().width) : null; })()`);
                    assert.ok(tw !== null && tw > 300, `the table keeps the page's width beside the pane (got ${tw})`);
                }
            });
            await S.run(`${label}: the row is marked current while the pane is open, and the header and the tab strip have not moved`, async () => {
                assert.deepEqual(await ev(`(() => { const e = ${row('/' + ART + '/')}; return e ? { current: e.getAttribute('aria-current'), selected: e.getAttribute('aria-selected') } : null; })()`), { current: 'true', selected: 'false' }, 'the preview row is current without being selected for a bulk action');
                const open = await rect(ev); await closeRow(); const closed = await rect(ev);
                // Below 1500 px the sidebar is the 56 px rail while the pane is open, so the page's left edge and width change with it; the header and the tab strip do not move up or down or change height.
                const keys = w >= 1500 ? ['x', 'y', 'w', 'h'] : ['y', 'h'];
                for (const part of ['h1', 'tabs']) for (const k of keys) assert.ok(Math.abs(open[part][k] - closed[part][k]) <= 0.5, `the ${part} ${k} moved when the pane closed (${open[part][k]} to ${closed[part][k]})`);
                await openRow();
            });
            await S.run(`${label}: Escape closes the pane and the focus returns to the row; Close details does the same`, async () => {
                await closeRow(); assert.equal(await paneBox(), null, 'Escape closes the pane');
                assert.ok(await ev(`document.activeElement && document.activeElement.textContent.includes(${JSON.stringify(ART)})`), 'the focus is on the row after Escape');
                await openRow();
                assert.ok(await ev(`(() => { const b = [...window.__tp.pane().querySelectorAll('button')].find(x => window.__na.name(x) === 'Close details'); if (!b) return false; b.click(); return true; })()`), 'no Close details button');
                await settle(300); assert.equal(await paneBox(), null, 'Close details closes the pane');
                assert.ok(await ev(`document.activeElement && document.activeElement.textContent.includes(${JSON.stringify(ART)})`), 'the focus is on the row after Close details');
            });
            await S.run(`${label}: goals, tasks and agents never open a pane`, async () => {
                for (const t of ['Goals', 'Tasks', 'Agents']) { await goTab(ev, settle, t); await ev(`(() => { const r = [...window.__tp.page().querySelectorAll('tbody tr, [role=row]')].find(x => !x.querySelector('th')); if (r) r.click(); return true; })()`); await settle(300); assert.equal(await paneBox(), null, `${t}: no Details pane`); await ev(`(() => { const b = window.__tp.find('button, a', /^(\\u2190\\s*)?(Goals|Tasks|Agents)$/); if (b) b.click(); return true; })()`); await settle(200); }
            });
        }
        await removeBoards(ev, [TEAM]); S.finish(); // finish() exits the process, so the board goes first
    } finally { await removeBoards(ev, [TEAM]); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
