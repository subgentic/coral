// Every team tab's page uses the full width of the page area (#7729, the operator: "The artifacts should take up the width of the screen here"): the Goals, Tasks, Agents, Artifacts and Knowledge pages were one shared class with
// a 1100 px cap, so on a wide window their tables sat in a column with empty space beside it. At 1280, 1600 and 1920 px each page is as wide as its panel, and its table (where it has one) is as wide as the page's content.
// The Artifacts tab says "Showing 100 of N" under the table with its Load more button, not above it as a count line. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');

const TEAM = `qa-width-${Date.now() % 100000}`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const w of [1280, 1600, 1920]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(); await installTP(ev);
            await seed(ev, TEAM);
            // the Artifacts tab with a paged list: 100 of 163 (the server's answer, stubbed)
            await ev(`(() => { const R = window.fetch; const items = Array.from({ length: 163 }, (_, i) => ({ name: 'report-' + String(i).padStart(3, '0') + '.md', media_type: 'text/markdown', size: 2048 + i, task_id: 100 + i, task_title: 'Task ' + i, produced_by: 'w-agent', created_at: new Date(Date.UTC(2026, 9, 10, 12, 0, 0) - i * 60000).toISOString(), uri: 'coral://artifacts/' + String(i).padStart(64, 'a') }));
                window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); if (/^\\/api\\/board\\/[^/]+\\/artifacts$/.test(url.pathname) && (o.method || 'GET') === 'GET') { const off = Number(url.searchParams.get('offset') || 0), lim = Number(url.searchParams.get('limit') || 100);
                    return Promise.resolve(new Response(JSON.stringify({ project: ${JSON.stringify(TEAM)}, artifacts: items.slice(off, off + lim), has_more: off + lim < items.length, total: items.length, all: items.length, truncated: false }), { status: 200, headers: { 'content-type': 'application/json' } })); }
                    if (url.pathname === '/api/system/artifact-store/kept') return Promise.resolve(new Response(JSON.stringify({ kept: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); return R(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM).catch(() => {}); await settle(1500);
            for (const tab of ['Goals', 'Tasks', 'Agents', 'Artifacts', 'Knowledge']) {
                await goTab(ev, settle, tab); await settle(400);
                const r = await ev(`(() => { const panel = [...document.querySelectorAll('.team-panel')].find(p => p.getClientRects().length > 0 && p.getAttribute('aria-label') === ${JSON.stringify(tab)}); if (!panel) return null;
                    const page = panel.querySelector('.goals-table-page'); if (!page) return { nopage: true };
                    const cs = getComputedStyle(page), inner = page.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
                    const table = page.querySelector('.dt-box'); const t = table ? table.getBoundingClientRect().width : null;
                    return { panel: panel.clientWidth, page: Math.round(page.getBoundingClientRect().width), inner: Math.round(inner), table: t === null ? null : Math.round(t) }; })()`);
                assert.ok(r && !r.nopage, `${w}: the ${tab} tab has its page ${JSON.stringify(r)}`);
                assert.ok(Math.abs(r.page - r.panel) <= 1, `${w}: ${tab}: the page is as wide as the page area ${JSON.stringify(r)}`);
                if (r.table !== null) assert.ok(Math.abs(r.table - r.inner) <= 2, `${w}: ${tab}: the table is as wide as the page's content ${JSON.stringify(r)}`);
                if (tab === 'Artifacts') {
                    await waitFor(`document.querySelectorAll('#team-panel-artifacts tbody tr').length === 100`, 'the first 100 artifacts', 10000);
                    const f = await ev(`(() => { const p = document.getElementById('team-panel-artifacts'), t = p.querySelector('.dt-table').getBoundingClientRect(), foot = p.querySelector('.dt-foot'), page = p.querySelector('.goals-table-page'), pc = getComputedStyle(page);
                        const above = [...p.querySelectorAll('.team-count-line, p')].filter(e => !e.classList.contains('sr-only') && e.getClientRects().length > 0 && /Showing 100 of 163/.test(e.textContent)).length;
                        const ft = foot ? foot.getBoundingClientRect() : null;
                        return { tableW: Math.round(t.width), inner: Math.round(page.clientWidth - parseFloat(pc.paddingLeft) - parseFloat(pc.paddingRight)), footText: foot ? foot.textContent.replace(/\\s+/g, ' ').trim() : null, footBelow: !!ft && ft.top >= t.bottom - 1, footLeft: ft ? Math.round(ft.left - t.left) : null, visibleAbove: above, srStatus: [...p.querySelectorAll('.sr-only[role="status"]')].map(e => e.textContent).filter(Boolean) }; })()`);
                    assert.ok(Math.abs(f.tableW - f.inner) <= 2, `${w}: the Artifacts table is as wide as the page's content ${JSON.stringify(f)}`);
                    assert.equal(f.footText, 'Showing 100 of 163Load more', `${w}: the count and Load more are one row ${JSON.stringify(f)}`);
                    assert.ok(f.footBelow, `${w}: that row is under the table ${JSON.stringify(f)}`);
                    assert.equal(f.visibleAbove, 0, `${w}: no count line above the table ${JSON.stringify(f)}`);
                    assert.deepEqual(f.srStatus, ['Showing 100 of 163'], `${w}: a screen reader still hears the count ${JSON.stringify(f)}`);
                }
                if (tab === 'Artifacts' && process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await ev(`document.getElementById('team-panel-artifacts').querySelector('.dt-foot').scrollIntoView({ block: 'end' }); new Promise(r => setTimeout(r, 300))`); /* sleep-ok: a screenshot waits out scrolling */ fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/artifacts-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
                console.log(`   ✓ ${w} ${tab} ${JSON.stringify(r)}`);
            }
        }
        console.log('PASS Every team tab uses the full width of the page area at 1280, 1600 and 1920 px');
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
