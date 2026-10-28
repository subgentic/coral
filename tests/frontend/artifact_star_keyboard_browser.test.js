// The star on artifact rows by keyboard and screen reader (#9899, v2.0.3: #9834): Inbox > Artifacts. Real keys (Tab, Enter, Space), names as Chrome computes them (axName), 1280 and 390 px, 200% text, forced colours.
//   - Tab reaches an unstarred row's star (hidden at rest, drawn on focus), its name is "Star <file>" and it is a toggle button; Enter and Space star and unstar it (PUT then DELETE), the keyboard stays on the star and its name follows;
//   - a starred row's name says ", starred" once and its filled star is drawn at rest; on a phone the starred glyph is a mark (hidden from a screen reader, no tap, not in the Tab order) and the name says it once;
//   - at 200% text the star is inside its row and the table does not scroll sideways; in forced colours the star's keyboard focus is outlined.
// The route is stood in as in inbox_artifacts_browser (same world); the page, the table and the star are the real ones, on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { axName } = require('./helpers/ax_tree');
const BASE = require('./test_base').BASE;

const WORLD = `(() => {
    const real = window.fetch; window.__ta = []; window.__star = [];
    const at = m => new Date(Date.now() - m * 60000).toISOString();
    const A = [
        { n: 1, name: 'beta-notes.txt', mt: 'text/plain', board: 'beta', m: 5, task: 12, title: 'Write the notes' },
        { n: 2, name: 'alpha-report.md', mt: 'text/markdown', board: 'alpha', m: 20, task: 7, title: 'Build the report' },
        { n: 3, name: 'beta-data.json', mt: 'application/json', board: 'beta', m: 40, task: 11, title: 'Export the data' },
        { n: 4, name: 'alpha-chart.png', mt: 'image/png', board: 'alpha', m: 60, task: 8, title: 'Draw the chart' },
        { n: 5, name: 'alpha-plan.md', mt: 'text/markdown', board: 'alpha', m: 90, task: 6, title: 'Plan the work' },
    ].map(a => ({ id: String(a.n).padStart(64, '0'), name: a.name, media_type: a.mt, size: 1000 * a.n, created_at: at(a.m), task_id: a.task, task_title: a.title, source: 'task', uri: 'coral://artifacts/' + String(a.n).padStart(64, '0'),
        available: true, inline: false, reference_count: 1, board_id: a.board, team: a.board, starred: a.n === 2 }));
    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));
    window.fetch = (u, o = {}) => {
        const url = new URL(String(u), location.origin), p = url.pathname, m = (o.method || 'GET').toUpperCase();
        if (p === '/api/team-artifacts' && m === 'GET') {
            window.__ta.push(url.search);
            const teams = url.searchParams.getAll('team'), q = (url.searchParams.get('q') || '').toLowerCase();
            const rows = A.filter(a => (!teams.length || teams.includes(a.board_id)) && (!q || a.name.includes(q)));
            const limit = Number(url.searchParams.get('limit') || 100);
            return json({ artifacts: rows.slice(0, limit), limit, offset: 0, has_more: rows.length > limit, truncated: false, total: rows.length, all: A.length,
                teams: [{ board_id: 'alpha', team: 'alpha', all: 3 }, { board_id: 'beta', team: 'beta', all: 2 }] });
        }
        const sr = /^\\/api\\/artifacts\\/([0-9a-f]{64})\\/star$/.exec(p); if (sr && (m === 'PUT' || m === 'DELETE')) { window.__star.push(m + ' ' + sr[1]); return json({ starred: m === 'PUT' }); }
        if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
        let r = /^\\/api\\/artifacts\\/([0-9a-f]{64})$/.exec(p);
        if (r && m === 'GET') return Promise.resolve(new Response('the text of ' + r[1].replace(/^0+/, ''), { status: 200, headers: { 'content-type': 'text/plain' } }));
        if (/^\\/api\\/artifacts\\/[0-9a-f]{64}\\/(meta|readers|comments)/.test(p)) return json({ error: 'not found' }, 404);
        return real(u, o);
    };
    return true; })()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], ' ': [32, 'Space'], Shift: [16, 'ShiftLeft'] };
    const key = async (k, shift) => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined; const mods = shift ? 8 : 0; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: mods }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code, modifiers: mods }); await new Promise(r => setTimeout(r, 200)); }; // sleep-ok: the key's handlers and the star's request run
    const tag = async (sel, a) => { await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.setAttribute('data-axp', 'x'); return !!e; })()`); const r = await axName(client, '[data-axp="x"]'); await ev(`document.querySelectorAll('[data-axp]').forEach(e => e.removeAttribute('data-axp')); true`); return r; };
    const rowOf = file => `#group-table-view tbody tr:has([aria-label*="${file}"], [data-row-name="${file}"], .dt-primary)`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            const check = (ok, msg) => { if (!ok) problems.push(`${label}: ${msg}`); };
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.then(() => true)`);
            await ev(`localStorage.removeItem('coral.inbox.tab'); localStorage.removeItem('coral-team-artifacts-filters:@inbox'); ${WORLD}`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            if (!mobile) { await waitFor(`!!document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]')`, 'the Artifacts folder', 10000); await ev(`document.querySelector('[data-view-list="inbox-folders"] .view-list-item[data-key="artifacts"]').click(); true`); }
            else await ev(`import((window.__coralStatic || '/static/') + 'inbox_sidebar.js').then(m => m.openInboxGroup('artifacts')).then(() => true)`);
            await waitFor(`document.getElementById('group-table-view').dataset.group === 'hub-inbox:artifacts' && document.querySelectorAll('#group-table-view tbody tr').length === 5`, `${label}: five rows`, 10000);
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table settles
            const rows = await ev(`[...document.querySelectorAll('#group-table-view tbody tr')].map((r, i) => ({ i, text: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), btn: !!r.querySelector('button.dt-star'), glyph: !!r.querySelector('.dt-mail-star, .dt-star-on'), name: [...r.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(n => !/star/i.test(n) || /, starred/.test(n)).slice(0, 2) }))`);
            if (!mobile) {
                // an unstarred row (beta-notes.txt, the first): Tab reaches its star, which is drawn when it has the keyboard
                const star = `#group-table-view tbody tr:nth-child(1) button.dt-star`;
                check(await ev(`!!document.querySelector(${JSON.stringify(star)}) && getComputedStyle(document.querySelector(${JSON.stringify(star)})).opacity === '0'`), 'the unstarred row has a star button, hidden at rest');
                await key('Shift'); await ev(`document.querySelector('#group-table-view tbody tr:nth-child(1) .dt-primary, #group-table-view tbody tr:nth-child(1) button').focus(); true`);
                let on = false; for (let i = 0; i < 6 && !on; i++) { await key('Tab'); on = await ev(`document.activeElement && document.activeElement.classList.contains('dt-star') && !!document.activeElement.closest('tr:nth-child(1)')`); }
                check(on, "Tab reaches the first row's star");
                if (on) {
                    check(await ev(`getComputedStyle(document.activeElement).opacity === '1'`), "the star is drawn when it has the keyboard");
                    const ax = await tag('.dt-star:focus', 1); check(!!ax && ax.role === 'button' && /^Star beta-notes\.txt$/.test(ax.name), `its name is "Star <file>", a button: ${JSON.stringify(ax)}`);
                    check(await ev(`document.activeElement.getAttribute('aria-pressed') === 'false'`), 'aria-pressed says it is not starred');
                    await key('Enter');
                    check(await ev(`window.__star.join() === 'PUT ${'1'.padStart(64, '0')}'`), `Enter stars it (PUT): ${await ev(`window.__star.join()`)}`);
                    const a2 = await ev(`(() => { const e = document.activeElement; return { star: e.classList.contains('dt-star'), label: e.getAttribute('aria-label'), pressed: e.getAttribute('aria-pressed') }; })()`);
                    check(a2.star && a2.label === 'Remove the star from beta-notes.txt' && a2.pressed === 'true', `the keyboard stays on the star and its name follows: ${JSON.stringify(a2)}`);
                    await key(' ');
                    check(await ev(`window.__star.join() === 'PUT ${'1'.padStart(64, '0')},DELETE ${'1'.padStart(64, '0')}'`), `Space unstars it (DELETE): ${await ev(`window.__star.join()`)}`);
                    check(await ev(`document.activeElement.getAttribute('aria-label') === 'Star beta-notes.txt'`), 'and the name is back');
                }
                // the starred row (alpha-report.md, the second): its filled star is drawn at rest, and the row's name says starred once
                check(await ev(`(() => { const b = document.querySelector('#group-table-view tbody tr:nth-child(2) button.dt-star'); return !!b && b.classList.contains('dt-star-on') && getComputedStyle(b).opacity === '1'; })()`), 'the starred row draws its filled star at rest');
                const nm = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr:nth-child(2)'); return [...r.querySelectorAll('[aria-label], [data-row-name]')].map(e => e.getAttribute('aria-label') || e.dataset.rowName).filter(n => /alpha-report/.test(n)); })()`);
                check(nm.some(n => /, starred$/.test(n)) && nm.every(n => (n.match(/starred/g) || []).length <= 1 && !/Remove the star/.test(n) || /^Remove the star/.test(n)), `the starred row's name says ", starred" once: ${JSON.stringify(nm)}`);
                // 200% text: the star is inside its row and nothing scrolls sideways
                await ev(`document.documentElement.style.fontSize = '32px'; true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the table follows the text size
                const big = await ev(`(() => { const t = document.querySelector('#group-table-view .dt-box'); const b = document.querySelector('#group-table-view tbody tr:nth-child(2) button.dt-star'), r = b.closest('tr').getBoundingClientRect(), s = b.getBoundingClientRect(); return { inside: s.left >= r.left - 1 && s.right <= r.right + 1 && s.width > 0, scroll: t.scrollWidth > t.clientWidth + 1, doc: document.documentElement.scrollWidth <= innerWidth }; })()`);
                check(big.inside && !big.scroll && big.doc, `at 200% text the star is inside its row and the table does not scroll sideways: ${JSON.stringify(big)}`);
                await ev(`document.documentElement.style.fontSize = ''; true`);
                // forced colours: the star's keyboard focus is outlined
                await client.Emulation.setEmulatedMedia({ features: [{ name: 'forced-colors', value: 'active' }] }); await new Promise(r => setTimeout(r, 300)); // sleep-ok: the media change applies
                await key('Shift'); await ev(`document.querySelector('#group-table-view tbody tr:nth-child(1) button.dt-star').focus(); true`); await new Promise(r => setTimeout(r, 150)); // sleep-ok: focus-visible
                const fc = await ev(`(() => { const cs = getComputedStyle(document.activeElement); return { outline: cs.outlineStyle + ' ' + cs.outlineWidth, opacity: cs.opacity }; })()`);
                check(!/^none/.test(fc.outline) && !/ 0px$/.test(fc.outline) && fc.opacity === '1', `forced colours: the star's keyboard focus is outlined and drawn: ${JSON.stringify(fc)}`);
                await client.Emulation.setEmulatedMedia({ features: [] });
            } else {
                // a phone: the starred row keeps a glyph that is a mark (no button, no tap, not heard), and its name says starred once; no row has a star control
                check(!rows.some(r => r.btn && r.glyph && false) && (await ev(`document.querySelectorAll('#group-table-view button.dt-star').length === 0 || [...document.querySelectorAll('#group-table-view button.dt-star')].every(b => getComputedStyle(b).display === 'none' || getComputedStyle(b).pointerEvents === 'none')`)), 'no star control a finger can use on a phone');
                const g = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr:nth-child(2)'), s = r.querySelector('.dt-mail-star'); return { glyph: !!s, hidden: s && s.getAttribute('aria-hidden'), pe: s && getComputedStyle(s).pointerEvents, tab: s && s.tabIndex, names: [...r.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(n => /alpha-report/.test(n)) }; })()`);
                check(g.glyph && g.hidden === 'true' && g.pe === 'none' && g.tab === -1, `the starred row's glyph is a mark (hidden from a screen reader, no tap, not in the Tab order): ${JSON.stringify(g)}`);
                check(g.names.length > 0 && g.names.every(n => (n.match(/starred/g) || []).length === 1), `the row's name says starred once: ${JSON.stringify(g.names)}`);
                const other = await ev(`!document.querySelector('#group-table-view tbody tr:nth-child(1) .dt-mail-star')`); check(other, 'an unstarred row has no glyph');
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the artifact star by keyboard and screen reader:\n  ' + problems.join('\n  '));
    console.log('PASS the artifact star by keyboard and screen reader');
})().catch(e => { console.error(e); process.exit(1); });
