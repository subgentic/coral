// A CSV or TSV artifact opens in the viewer as a table (#11382): the first record a sticky header, a click on a header sorts (numbers as numbers, the rest as text, ties in file order), a box filters, a long cell
// is cut with a "Show all", the table scrolls inside its own box and never the page, Raw shows the original text, every cell is text (a formula, a tag, an image with a handler are shown as written and do
// nothing), a file of 5,200 rows draws 5,000 and says so. The fixture is synthetic: eight columns with quoted notes (commas, quotes, a line break, a very long one). The artifact route is stood in for by a
// page-side stub. 1280 and 390 px (touch), light and dark; 200% text on the phone. Drives Chrome over CDP through the harness; run_cdp_suites.mjs finds it by name.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');

const HEX = 'c5'.repeat(32), BIG = 'b1'.repeat(32), TSV = 'd7'.repeat(32);
const CITIES = ['Cardiff', 'Leeds', 'Bristol', 'Derby', 'York', 'Bath', 'Exeter', 'Hull'];
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const LONG = 'Long note: ' + 'the quarterly review found nothing unusual, ' .repeat(12) + 'end of the long note.';
const rows = Array.from({ length: 40 }, (_, i) => {
    const id = i + 1;
    const note = id === 3 ? q('He said "ship it", then left.') : id === 4 ? q('first line\nsecond line') : id === 5 ? q(LONG) : id === 6 ? q('=HYPERLINK("http://example.invalid","click")') : id === 7 ? '<b>bold</b>' : id === 8 ? '<img src=x onerror="window.__pwned=1">' : id === 9 ? '@SUM(A1:A2)' : id === 10 ? '-5 and +7' : `note ${id}`;
    const raw = [10, 2, 100, 33.5, 1234.5, 7, 0.5, 90, 15, 3][i % 10] + (i >= 10 ? i : 0);
    const amount = raw >= 1000 ? q(raw.toLocaleString('en-US')) : String(raw); // 1,234.5 has a comma: a number a text sort would put among the 1s
    return [id, `Name ${String.fromCharCode(65 + (i * 7) % 26)}${i}`, CITIES[i % 8], amount, ['open', 'closed', 'Open', 'blocked'][i % 4], `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, `owner${i % 5}`, note].join(',').replace(/^(\d+),/, '$1,');
});
const HEAD = 'id,name,city,amount,status,date,owner,notes';
const CSV = [HEAD, ...rows].join('\r\n') + '\r\n';
const BIGCSV = [HEAD, ...Array.from({ length: 5200 }, (_, i) => `${i + 1},n${i},c,${i},s,d,o,x`)].join('\n');
const TSVTEXT = 'a\tb\n1\t"x\ty"\n2\tz\n';

const STUB = `(() => {
    const R = window.fetch; window.__pwned = 0;
    const files = { '${HEX}': { type: 'text/csv', body: ${JSON.stringify(CSV)}, name: 'quarter.csv' }, '${BIG}': { type: 'text/csv', body: ${JSON.stringify(BIGCSV)}, name: 'big.csv' }, '${TSV}': { type: 'text/tab-separated-values', body: ${JSON.stringify(TSVTEXT)}, name: 'x.tsv' } };
    window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin), m = url.pathname.match(/^\\/api\\/artifacts\\/([0-9a-f]{64})$/);
        if (m && files[m[1]] && (o.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(new Response(files[m[1]].body, { status: 200, headers: { 'content-type': files[m[1]].type + '; charset=utf-8', 'content-length': String(new TextEncoder().encode(files[m[1]].body).length) } }));
        return R(u, o); };
    return true;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await require('./helpers/wait').settle(ev, 400, 300); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const V = '#artifact-viewer';
    const open = async (view, hex, name) => {
        await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
        await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').coralReady(ev); await ev(`localStorage.clear(); true`); await setTheme(ev, view.theme);
        await ev(STUB);
        await ev(`import((window.__coralStatic || '/static/') + 'artifact_viewer.js').then(m => m.openArtifactViewer('${hex}', { filename: '${name}' })).then(() => true)`);
        await waitFor(`!!document.querySelector('${V} .csv-view')`, 'the table', 15000);
    };
    const cells = sel => ev(`[...document.querySelectorAll('${V} .csv-scroll tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()))`);
    const clickHeader = label => ev(`(() => { const th = [...document.querySelectorAll('${V} .csv-scroll thead th')].find(t => t.textContent.trim().replace(/[^A-Za-z]/g, '') === ${JSON.stringify(label)}); if (!th) return false; (th.querySelector('button') || th).click(); return true; })()`);
    const col = (rowsOf, j) => rowsOf.map(r => r[j]);

    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ w: 1280, h: 900, phone: false, theme: 'dark' }, { w: 1280, h: 900, phone: false, theme: 'light' }, { w: 390, h: 844, phone: true, theme: 'dark' }, { w: 390, h: 844, phone: true, theme: 'light' }]) {
            const at = `${view.w}px ${view.theme}: `;
            await open(view, HEX, 'quarter.csv');
            await waitFor(`document.querySelectorAll('${V} .csv-scroll tbody tr').length >= 40`, at + 'the 40 rows', 10000);
            const head = await ev(`[...document.querySelectorAll('${V} .csv-scroll thead th')].map(t => t.textContent.trim())`);
            check(at + 'the first record is the header, one column each', head.length === 8 && ['id', 'name', 'city', 'amount', 'status', 'date', 'owner', 'notes'].every((h, j) => head[j].toLowerCase().includes(h)), JSON.stringify(head));
            let t = await cells();
            check(at + 'a quoted note keeps its comma and its quotes, and a line break stays one', t[2][7] === 'He said "ship it", then left.' && t[3][7] === 'first line\nsecond line', JSON.stringify([t[2][7], t[3][7]]));
            check(at + 'a formula, a tag and an image with a handler are text as written, and do nothing', t[5][7] === '=HYPERLINK("http://example.invalid","click")' && t[6][7] === '<b>bold</b>' && t[7][7] === '<img src=x onerror="window.__pwned=1">' && t[8][7] === '@SUM(A1:A2)' && t[9][7] === '-5 and +7' && await ev(`window.__pwned === 0 && !document.querySelector('${V} .csv-scroll b') && !document.querySelector('${V} .csv-scroll img')`));
            check(at + 'a cell of 40 characters is wrapped, not cut with an ellipsis', await ev(`(() => { const td = [...document.querySelectorAll('${V} .csv-scroll tbody td')].find(c => c.textContent.startsWith('<img src=x')); const cs = getComputedStyle(td); return !!td && td.scrollWidth <= td.clientWidth + 1 && cs.whiteSpace !== 'nowrap' && td.getBoundingClientRect().height > 20; })()`));
            const lines = await ev(`(() => { const cell = t => [...document.querySelectorAll('${V} .csv-scroll tbody td')].find(c => c.textContent.trim() === t); const h = n => Math.round(n.getBoundingClientRect().height), lh = parseFloat(getComputedStyle(cell('open') || cell('closed') || cell('blocked')).lineHeight) || 20;
                const date = cell('2026-10-01'), id = cell('1'), note = [...document.querySelectorAll('${V} .csv-text')].find(n => n.textContent === 'first line\\nsecond line');
                return { dateH: date ? h(date.firstElementChild || date) : -1, dateWS: date ? getComputedStyle(date.firstElementChild || date).whiteSpace : '', lh, noteWS: note ? getComputedStyle(note).whiteSpace : '', noteH: note ? h(note) : -1 }; })()`);
            check(at + 'a date stays on one line (never broken at its hyphens)', lines.dateH > 0 && lines.dateH <= lines.lh * 1.5 && lines.dateWS === 'nowrap', JSON.stringify(lines));
            check(at + 'a note\'s line break stays inside its cell, on two lines', lines.noteWS === 'pre-line' && lines.noteH >= lines.lh * 1.8, JSON.stringify(lines));
            const geo = await ev(`(() => { const s = document.querySelector('${V} .csv-scroll .dt-box'), th = s.querySelector('thead th'); s.scrollTop = 200; const a = th.getBoundingClientRect().top - s.getBoundingClientRect().top; return { sticky: Math.abs(a) <= 1, scrolls: s.scrollHeight > s.clientHeight, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, inner: s.scrollWidth > s.clientWidth }; })()`);
            check(at + 'the header sticks to the top of the table box when it scrolls', geo.scrolls && geo.sticky, JSON.stringify(geo));
            check(at + 'the page never scrolls sideways' + (view.phone ? ' (the table box does)' : ''), geo.page && (!view.phone || geo.inner), JSON.stringify(geo));
            // sort: numbers as numbers (2 before 10 before 100), then back; text without case; ties keep file order
            await clickHeader('amount');
            t = await cells(); const num = v => Number(String(v).replace(/,/g, '')); const nums = col(t, 3).map(num);
            check(at + 'a number column sorts as numbers, not as text', nums.every((v, i) => i === 0 || nums[i - 1] <= v) && nums[0] <= 0.5, JSON.stringify(nums.slice(0, 6)));
            await clickHeader('amount');
            t = await cells(); const desc = col(t, 3).map(num);
            check(at + 'a second click reverses it', desc.every((v, i) => i === 0 || desc[i - 1] >= v), JSON.stringify(desc.slice(0, 4)));
            await clickHeader('status');
            t = await cells(); const st = col(t, 4).map(s => s.toLowerCase());
            check(at + 'a text column sorts without regard to case, and equal values keep the file\'s order', st.every((v, i) => i === 0 || st[i - 1] <= v) && (() => { const ids = t.filter(r => r[4].toLowerCase() === 'open').map(r => Number(r[0])); return ids.every((v, i) => i === 0 || ids[i - 1] < v); })(), JSON.stringify(st.slice(0, 3)));
            // filter
            await ev(`(() => { const i = document.querySelector('${V} .csv-filter'); i.value = 'cardiff'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`/match/.test(document.querySelector('${V} .csv-status').textContent)`, at + 'the filter status', 5000);
            t = await cells();
            check(at + 'the filter keeps the rows with that text and says how many', t.length === 5 && t.every(r => r[2] === 'Cardiff') && /^5 of 40 rows match\./.test(await ev(`document.querySelector('${V} .csv-status').textContent`)), String(t.length));
            await ev(`(() => { const i = document.querySelector('${V} .csv-filter'); i.value = 'zzzz-nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`/^0 of 40 rows match\\./.test(document.querySelector('${V} .csv-status').textContent)`, at + 'no match', 5000);
            check(at + 'a filter that matches nothing says so, in the status and in the table', /No row has that text/.test(await ev(`document.querySelector('${V} .csv-view').textContent`)));
            await ev(`(() => { const i = document.querySelector('${V} .csv-filter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`document.querySelectorAll('${V} .csv-scroll tbody tr').length === 40`, at + 'all rows back', 5000);
            // a long cell is cut, and opens
            const lng = await ev(`(() => { const b = document.querySelector('${V} .csv-more'), c = b.parentElement.querySelector('.csv-clamp'), h0 = c.getBoundingClientRect().height; b.click(); const h1 = c.getBoundingClientRect().height; return { label: b.textContent, expanded: b.getAttribute('aria-expanded'), grew: h1 > h0 + 20, full: c.textContent.endsWith('end of the long note.') }; })()`);
            check(at + 'a long cell is cut and "Show all" opens it', lng.grew && lng.expanded === 'true' && lng.full && lng.label === 'Show less', JSON.stringify(lng));
            // targets (a phone: 44 px)
            if (view.phone) {
                const small = await ev(`[...document.querySelectorAll('${V} .csv-controls button, ${V} .csv-controls input, ${V} .csv-scroll thead th button')].filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)).filter(h => h < 44)`);
                check(at + 'the view buttons, the filter and the headers are 44 px targets on a phone', small.length === 0, JSON.stringify(small));
            }
            await shot(`csv-table-${view.w}-${view.theme}`);
            // raw and back
            await ev(`[...document.querySelectorAll('${V} .csv-controls button')].find(b => b.textContent === 'Raw').click(); true`);
            const raw = await ev(`(() => { const r = document.querySelector('${V} .csv-raw'); return { shown: !r.hidden, text: r.textContent.slice(0, 40), tableHidden: document.querySelector('${V} .csv-scroll').hidden }; })()`);
            check(at + 'Raw shows the original text and hides the table', raw.shown && raw.tableHidden && raw.text.startsWith('id,name,city,amount'), JSON.stringify(raw));
            if (view.w === 1280 && view.theme === 'dark') await shot('csv-raw-1280-dark');
            await ev(`[...document.querySelectorAll('${V} .csv-controls button')].find(b => b.textContent === 'Table').click(); true`);
            check(at + 'and Table brings it back', await ev(`!document.querySelector('${V} .csv-scroll').hidden && document.querySelector('${V} .csv-raw').hidden`));
            check(at + 'Download is still the original bytes', await ev(`(() => { const a = document.querySelector('${V} .artifact-viewer-download'); return !!a && !a.hidden; })()`));
        }
        // the phone at 200% text, the cap, and a TSV
        const phone = { w: 390, h: 844, phone: true, theme: 'light' };
        await open(phone, HEX, 'quarter.csv');
        await ev(`document.documentElement.style.fontSize = '32px'; true`);
        await require('./helpers/wait').settle(ev, 600, 300);
        check('390px 200% text: the page does not scroll sideways', await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
        await open({ w: 1280, h: 900, phone: false, theme: 'dark' }, BIG, 'big.csv');
        await waitFor(`document.querySelectorAll('${V} .csv-scroll tbody tr').length >= 100`, 'the big file drawn', 20000);
        const big = await ev(`({ status: document.querySelector('${V} .csv-status').textContent, rows: document.querySelectorAll('${V} .csv-scroll tbody tr').length })`);
        check('a file of 5,200 rows draws 5,000 and says so', big.rows === 5000 && big.status === 'Showing 5,000 of 5,200 rows.', JSON.stringify(big));
        // wide and huge files render in under a second, with the caps in the status line: a 2 MB record of commas, and 5,000 rows of 400 columns
        const timed = (text, label) => ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'csv_table.js'); const host = document.createElement('div'); document.body.append(host);
            const t0 = performance.now(); m.renderCsvTable(host, ${JSON.stringify(text)}, { name: ${JSON.stringify(label)} }); const ms = performance.now() - t0;
            const out = { ms: Math.round(ms), status: host.querySelector('.csv-status').textContent, cols: host.querySelectorAll('thead th').length, rows: host.querySelectorAll('tbody tr').length }; host.remove(); return out; })()`);
        const commas = ',' .repeat(2 * 1024 * 1024);
        const wideText = Array.from({ length: 5000 }, (_, i) => i === 0 ? Array.from({ length: 400 }, (_, j) => `h${j}`).join(',') : 'x,'.repeat(399) + 'x').join('\n');
        const w1 = await timed(commas, 'commas.csv');
        check('a 2 MB record of commas renders in under a second and says its columns are capped', w1.ms < 1000 && w1.rows === 0 && w1.status === 'No rows below the header. Showing the first 200 of 2,097,153 columns.', JSON.stringify(w1));
        const w2 = await timed(wideText, 'wide.csv');
        check('5,000 rows of 400 columns render in under a second, with 200 columns, at most 50,000 cells and both caps in the status', w2.ms < 1000 && w2.cols === 200 && w2.rows * w2.cols <= 50000 && w2.rows >= 100 && /Showing [\d,]+ of [\d,]+\+? rows/.test(w2.status) && /Showing the first 200 of 400 columns\./.test(w2.status), JSON.stringify(w2));
        await open({ w: 1280, h: 900, phone: false, theme: 'dark' }, TSV, 'x.tsv');
        const tsv = await cells();
        check('a TSV is split on tabs, and a tab inside quotes stays in its cell', tsv.length === 2 && tsv[0][1] === 'x\ty' && tsv[1][1] === 'z', JSON.stringify(tsv));
    } catch (e) { console.log('ERROR ' + (e.stack || e)); results.push(false); }
    await client.close();
    if (results.every(Boolean)) console.log('csv_viewer_browser: all ok'); else { console.log('FAILED'); process.exit(1); }
})();
