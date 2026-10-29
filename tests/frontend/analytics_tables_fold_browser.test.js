// The Analytics tables at 390 px are one line a row (#8982: the name and Cost, Calls in the calls table, a row's own Details link; the other columns drop), no table scrolls sideways. At 1280 px with 200% text they fold (task 7738, UI/UX's #7721 follow-up): no table scrolls sideways; each row is its name, then its figures as "label value" under it,
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
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = scenarios();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, h, mobile) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
        await ev(`window.switchNavTab('tokens'); true`); await settle(1500);
    };
    const view = async key => { await ev(`(() => { const g = ({ provider: 'Provider', model: 'Model', thinking: 'Thinking level', team: 'Team', agent: 'Agent', branch: 'Branch', task: 'Task' })[${JSON.stringify(key)}]; const b = g ? [...document.querySelectorAll('#cost-group-bar .eff-seg-btn')].find(x => x.textContent === g) : document.querySelector('#cost-nav-list .row-btn[data-view="${key}"]'); if (b) b.click(); return !!b; })()`); await settle(900); }; // a grouping is Overview's Group by (#9236)
    const probe = () => ev(`(() => { const box = [...document.querySelectorAll('#cost-dashboard-view .dt-box')].find(b => b.getClientRects().length && b.querySelector('table')); if (!box) return null; const t = box.querySelector('table');
        const row = t.querySelector('tbody tr'); const cells = row ? [...row.querySelectorAll('td:not(.dt-check)')] : []; const top = e => Math.round(e.getBoundingClientRect().top); const bar = box.querySelector('.dt-sortbar');
        return { sideways: box.scrollWidth > box.clientWidth + 1, pageSw: document.documentElement.scrollWidth > innerWidth + 1, display: getComputedStyle(t).display, head: getComputedStyle(t.querySelector('thead')).display, roles: [t.getAttribute('role'), row && row.getAttribute('role'), cells[0] && cells[0].getAttribute('role')],
            labels: cells.map(c => c.dataset.label || ''), firstFull: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0, rowW: row ? Math.round(row.getBoundingClientRect().width) : 0, tops: cells.map(top),
            first: cells.filter(c => c.classList.contains('dt-fold-first')).map(c => c.dataset.label), before: [...new Set(cells.filter(c => !c.classList.contains('dt-tone-primary')).map(c => getComputedStyle(c, '::before').content))],
            sortBar: !!(bar && bar.getClientRects().length), sortKey: bar && bar.querySelector('select') ? bar.querySelector('select').value : '',
            strong: cells.filter(c => c.classList.contains('dt-fold-key')).map(c => { const st = getComputedStyle(c), k = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16; return [c.dataset.label, Math.round(parseFloat(st.fontSize) / k) + 'px', st.fontWeight]; }),
            rest: [...new Set(cells.filter(c => !c.classList.contains('dt-fold-key') && !c.classList.contains('dt-tone-primary') && c.dataset.label).map(c => { const st = getComputedStyle(c), k = parseFloat(getComputedStyle(document.documentElement).fontSize) / 16; return Math.round(parseFloat(st.fontSize) / k) + 'px,' + st.fontWeight; }))], rows: t.querySelectorAll('tbody tr').length }; })()`);
    const lineProbe = () => ev(`(() => { const box = [...document.querySelectorAll('#cost-dashboard-view .dt-box')].find(b => b.getClientRects().length && b.querySelector('table')); if (!box) return null; const t = box.querySelector('table'), row = t.querySelector('tbody tr');
        const heads = [...t.querySelectorAll('thead th')].filter(h => h.getClientRects().length && getComputedStyle(h).display !== 'none' && !h.classList.contains('dt-check')).map(h => h.textContent.replace(/[\u2191\u2193\u2195]/g, '').trim());
        const cells = row ? [...row.querySelectorAll('td:not(.dt-check)')].filter(c => c.getClientRects().length) : [], tops = cells.map(c => Math.round(c.getBoundingClientRect().top)), rr = row ? row.getBoundingClientRect() : { height: 0 };
        return { sideways: box.scrollWidth > box.clientWidth + 1, pageSw: document.documentElement.scrollWidth > innerWidth + 1, heads, firstCell: cells[0] ? cells[0].textContent.trim() : '', cells: cells.length, sameTop: tops.every(t => Math.abs(t - tops[0]) <= 3), rowH: Math.round(rr.height), folded: box.classList.contains('dt-folded'), rows: t.querySelectorAll('tbody tr').length }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        for (const [label, w, h, mobile, big] of [['390 px', 390, 844, true, false], ['1280 px at 200% text', 1280, 800, false, true]]) {
            await open(w, h, mobile); if (big) await ev(`document.documentElement.style.fontSize = '32px'; true`);
            if (mobile) for (const key of VIEWS) await S.run(`${label}: ${key} is one line a row: the name and ${key === 'calls' ? 'Calls' : 'Cost'}, the rest dropped`, async () => {
                await view(key);
                const p = await lineProbe(); assert.ok(p && p.rows > 0, 'the table is there'); await shot(`oneline-390-${key}`);
                assert.deepEqual([p.sideways, p.pageSw], [false, false], 'no sideways scroll: ' + JSON.stringify(p));
                assert.equal(p.folded, false, 'not stacked: ' + JSON.stringify(p));
                assert.ok(p.heads.length >= 2 && p.heads.length <= 3, 'the name, the figure (and a row link): ' + JSON.stringify(p.heads));
                assert.ok(p.heads.includes(key === 'calls' ? 'Calls' : 'Cost'), 'the figure the table is read for stays: ' + JSON.stringify(p.heads));
                if (key === 'model') assert.ok(!/^(claude|codex)/i.test(p.firstCell) && p.heads[0].startsWith('Model'), 'By model keeps the Model column, not the Provider: ' + JSON.stringify(p));
                if (key === 'thinking') assert.ok(p.heads[0].startsWith('Thinking level'), 'By thinking keeps the Thinking level column: ' + JSON.stringify(p));
                assert.ok(p.sameTop && p.rowH <= 72, 'one line: the cells are level and the row is short: ' + JSON.stringify(p));
            });
            else for (const key of VIEWS) await S.run(`${label}: ${key} folds, no sideways scroll`, async () => {
                await view(key); if (big) await settle(500);
                const p = await probe(); assert.ok(p, 'the table is there'); await shot(`fold-${mobile ? '390' : '200'}-${key}`);
                assert.deepEqual([p.sideways, p.pageSw], [false, false], 'no sideways scroll: ' + JSON.stringify(p));
                assert.equal(p.head, 'none', 'the header row is not drawn: ' + JSON.stringify(p));
                assert.deepEqual(p.roles, ['table', 'row', 'cell'], 'the roles stay: ' + JSON.stringify(p)); assert.ok(p.labels.slice(1).every(Boolean), 'every cell has its column name: ' + JSON.stringify(p.labels));
                assert.ok(p.firstFull >= p.rowW - 2 * 12 - 2, 'the name takes the row (inside its padding): ' + JSON.stringify(p)); assert.ok(p.tops[1] > p.tops[0], 'the figures are under the name: ' + JSON.stringify(p));
                assert.ok(p.first.length >= 1 && p.before.every(c => c.length > 2), 'Cost or Calls first, labels drawn: ' + JSON.stringify(p));
                assert.deepEqual([p.strong.length, p.strong[0] && p.strong[0].slice(1)], [1, ['13px', '600']], 'one stronger figure, the sort key\'s, 13/600: ' + JSON.stringify(p.strong)); assert.deepEqual(p.rest, ['12px,400'], 'the other lines 12/400: ' + JSON.stringify(p.rest));
                if (key !== 'calls') assert.ok(p.sortBar, 'a Sort by select is above it: ' + JSON.stringify(p));
            });
            if (!mobile) await S.run(`${label}: Sort by changes the order, and the reverse button reverses it`, async () => {
                await view('provider');
                const names = () => ev(`[...document.querySelectorAll('#cost-by-provider tbody tr')].map(r => r.querySelector('td:not(.dt-check)').textContent.trim())`);
                const before = await names();
                await ev(`(() => { const s = document.querySelector('#cost-by-provider .dt-sortbar select'); s.value = 'agent_type'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(600);
                const byName = await names();
                await ev(`document.querySelector('#cost-by-provider .dt-sortbar-dir').click(); true`); await settle(600);
                const reversed = await names();
                assert.deepEqual([...byName].sort(), [...before].sort(), 'the same rows'); assert.ok(JSON.stringify(byName) === JSON.stringify([...byName].sort()) || JSON.stringify(byName) === JSON.stringify([...byName].sort().reverse()), 'sorted by name: ' + JSON.stringify(byName));
                assert.deepEqual(reversed, [...byName].reverse(), 'reversed: ' + JSON.stringify({ byName, reversed }));
                await ev(`(() => { const s = document.querySelector('#cost-by-provider .dt-sortbar select'); s.value = 'requests'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await settle(600);
                assert.equal((await probe()).sortKey, 'requests', 'the select shows the column the rows are sorted by');
            });
        }
        await open(1280, 800, false);
        await S.run('1280 px at normal text: the tables are tables, as they were', async () => {
            for (const key of ['provider', 'agent', 'calls']) { await view(key); const p = await probe(); assert.ok(p, 'the table is there'); assert.deepEqual([p.display, p.head, p.sortBar], ['table', 'table-header-group', false], key + ': ' + JSON.stringify(p)); }
        });
    } finally { await client.close(); }
    S.finish();
})().catch(e => { console.error(e); process.exitCode = 1; });
