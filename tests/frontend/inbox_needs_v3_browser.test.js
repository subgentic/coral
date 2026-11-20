// Needs you, guidelines v3 section 4.14 (#17450): counts are numbers (N1), the header is two rows (N2), one Default button per row (N4), a cut list says "Showing 8 of N" (N8). 1440, 1280, 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`try { localStorage.removeItem('coral-inbox-needs-filters'); } catch {} true`);
            await ev(`(() => { for (let i = 0; i < 5; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'team-' + (i % 2), session_id: 'sid-' + i }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 5`, 'five agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const K = ['permission', 'question', 'plan', 'permission', 'question'];
                window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: K[i], waiting_since: ago(3 + i * 40) }));
                (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            if (mobile) await ev(`document.querySelector('#group-table-view .view-list-item[data-key="needs"]')?.click(); true`); else await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary, #group-table-view button.dt-person').length >= 5`, 'the five rows', 8000); await settle(400);
            await shot(`needs-${w}`);
            const g = await ev(`(() => { const r = e => e && e.getBoundingClientRect(), vis = e => e && r(e).width > 0, row = document.querySelector('.inbox-folder-toolbar .list-bar-search-row'), head = row && row.querySelector('.inbox-needs-tabs, .inbox-folder-head'), more = document.getElementById('needs-more'), parts = row ? [...row.querySelectorAll(':scope > .list-bar-search-wrap, :scope > .team-tb-pills, :scope > .list-bar-toggle')].filter(vis) : [], pills = row && row.querySelector(':scope > .team-tb-pills');
                return { headTop: head && Math.round(r(head).top), headBottom: head && Math.round(r(head).bottom), moreTop: more && Math.round(r(more).top), moreBottom: more && Math.round(r(more).bottom), moreText: more && more.textContent, moreRight: more && Math.round(r(more).right), partsTop: parts.map(e => Math.round(r(e).top)), partsRight: parts.map(e => Math.round(r(e).right)), robot: !!(row && row.querySelector('.agent-copy')), pillsCut: pills && vis(pills) ? pills.scrollWidth - pills.clientWidth : 0, primary: document.querySelectorAll('#group-table-view tbody .btn-primary').length, atLeast: /at least/i.test(document.getElementById('group-table-view').textContent), vw: innerWidth }; })()`);
            assert.equal(g.moreText, 'More', `${w}: row one ends in a More button`); assert.equal(g.robot, false, `${w}: the robot is an item in More, not a header icon`);
            assert.ok(g.headTop >= g.moreTop - 1 && g.headTop <= g.moreBottom, `${w}: title and More share row one (${g.headTop} vs ${g.moreTop})`);
            assert.ok(g.partsTop.length >= 1 && g.partsTop.every(t => t >= g.headBottom), `${w}: search, strip and Filters are on row two, under the title (${g.partsTop} vs ${g.headBottom})`);
            assert.ok(g.partsRight.every(x => x <= g.vw) && g.moreRight <= g.vw, `${w}: nothing runs off the right edge`); assert.equal(g.pillsCut, 0, `${w}: the strip is never cut`);
            assert.equal(g.primary, 0, `${w}: no blue Primary button in the list`); assert.equal(g.atLeast, false, `${w}: no "at least" on the page`);
        }
        await client.close(); process.exit(0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
