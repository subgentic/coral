// The Analytics tables fold when the page is narrow (task 7738, UI/UX's #7721 follow-up): at 390 px, and at 1280 px with 200% text, no table scrolls sideways; each row is its name, then its figures as "label value" under it,
// Cost (Calls in the calls table) first; the header row is not drawn but the table keeps its roles and each cell is read with its column's name; a "Sort by" select and an Ascending/Descending button above the table sort it. At 1280 px and
// normal text the tables are tables, as they were. Drives Chrome over CDP through agent_view_harness.js with the census data world.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD } = require('./helpers/census_world');
const { scenarios } = require('./helpers/team_page');
const BASE = require('./test_base').BASE;

const VIEWS = ['provider', 'model', 'thinking', 'team', 'agent', 'branch', 'calls'];

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.switchNavTab('tokens'); true`); await settle(1500);
    };
    const view = async key => { await ev(`(() => { const b = document.querySelector('#cost-nav-list .row-btn[data-view="${key}"]'); if (b) b.click(); return !!b; })()`); await settle(900); };
    const probe = () => ev(`(() => { const box = [...document.querySelectorAll('#cost-dashboard-view .cost-table-container')].find(b => b.getClientRects().length && b.querySelector('table')); if (!box) return null; const t = box.querySelector('table'); const r = box.getBoundingClientRect();
        const row = t.querySelector('tbody tr'); const cells = row ? [...row.children] : []; const top = e => Math.round(e.getBoundingClientRect().top);
        return { sideways: box.scrollWidth > box.clientWidth + 1, pageSw: document.documentElement.scrollWidth > innerWidth + 1, display: getComputedStyle(t).display, head: getComputedStyle(t.querySelector('thead')).display, roles: [t.getAttribute('role'), row && row.getAttribute('role'), cells[0] && cells[0].getAttribute('role')],
            labels: cells.map(c => c.dataset.label || ''), firstFull: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0, rowW: row ? Math.round(row.getBoundingClientRect().width) : 0, tops: cells.map(top), first: cells.filter(c => c.classList.contains('cost-fold-first')).map(c => c.dataset.label),
            before: cells[2] ? getComputedStyle(cells[2], '::before').content : '', sortBar: !!(box.previousElementSibling && box.previousElementSibling.classList.contains('cost-fold-sort') && box.previousElementSibling.getClientRects().length), rows: t.querySelectorAll('tbody tr').length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        for (const [label, w, h, mobile, big] of [['390 px', 390, 844, true, false], ['1280 px at 200% text', 1280, 800, false, true]]) {
            await open(w, h, mobile); if (big) await ev(`document.documentElement.style.fontSize = '32px'; true`);
            for (const key of VIEWS) await S.run(`${label}: ${key} folds, no sideways scroll`, async () => {
                await view(key); if (big) await settle(500);
                const p = await probe(); assert.ok(p, 'the table is there'); await shot(`fold-${mobile ? '390' : '200'}-${key}`);
                assert.deepEqual([p.sideways, p.pageSw], [false, false], 'no sideways scroll: ' + JSON.stringify(p));
                assert.equal(p.head, 'none', 'the header row is not drawn: ' + JSON.stringify(p));
                assert.deepEqual(p.roles, ['table', 'row', 'cell'], 'the roles stay: ' + JSON.stringify(p)); assert.ok(p.labels.slice(1).every(Boolean), 'every cell has its column name: ' + JSON.stringify(p.labels));
                assert.ok(p.firstFull >= p.rowW - 2 * 12 - 2, 'the name takes the row (inside its padding): ' + JSON.stringify(p)); assert.ok(p.tops[1] > p.tops[0], 'the figures are under the name: ' + JSON.stringify(p));
                assert.ok(p.first.length >= 1 && p.before.length > 2, 'Cost or Calls first, labels drawn: ' + JSON.stringify(p));
                if (key !== 'calls') assert.ok(p.sortBar, 'a Sort by select is above it: ' + JSON.stringify(p));
            });
            await S.run(`${label}: Sort by changes the order, and the reverse button reverses it`, async () => {
                await view('provider');
                const names = () => ev(`[...document.querySelectorAll('#cost-by-provider tbody tr')].map(r => r.children[0].textContent.trim())`);
                const before = await names();
                await ev(`(() => { const s = document.querySelector('.cost-fold-sort select'); s.value = 'agent_type'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(600);
                const byName = await names();
                await ev(`document.querySelector('.cost-fold-dir').click(); true`); await settle(600);
                const reversed = await names();
                assert.deepEqual([...byName].sort(), [...before].sort(), 'the same rows'); assert.ok(JSON.stringify(byName) === JSON.stringify([...byName].sort()) || JSON.stringify(byName) === JSON.stringify([...byName].sort().reverse()), 'sorted by name: ' + JSON.stringify(byName)); assert.notDeepEqual(byName, before, 'and not in the order the cost gave');
                assert.deepEqual(reversed, [...byName].reverse(), 'reversed: ' + JSON.stringify({ byName, reversed }));
            });
        }
        await open(1280, 800, false);
        await S.run('1280 px at normal text: the tables are tables, as they were', async () => {
            for (const key of ['provider', 'agent', 'calls']) { await view(key); const p = await probe(); assert.ok(p, 'the table is there'); assert.deepEqual([p.display, p.head, p.sortBar], ['table', 'table-header-group', false], key + ': ' + JSON.stringify(p)); }
        });
    } finally { await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
