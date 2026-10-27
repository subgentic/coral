// How many text lines each row of a table takes (Goal #79: one line a row): every visible text node of the row is measured with a Range, and the centres of its line boxes are grouped (a gap over 7 px starts a new line). The page-side
// expression is `rowLines(selector)` -> [{ name, lines }]; `oneLinePerRow(ev, selector, label, assert)` fails with the rows that take more than one.
const EXPR = sel => `(() => { const lines = tr => { const tops = new Set(); const w = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const p = n.parentElement; if (!p || !p.getClientRects().length || getComputedStyle(p).visibility === 'hidden' || p.closest('.sr-only')) continue;
        const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) if (b.width > 0 && b.height > 0) tops.add(b.top + b.height / 2); }
        const c = [...tops].sort((x, y) => x - y); let k = c.length ? 1 : 0; for (let i = 1; i < c.length; i++) if (c[i] - c[i - 1] > 7) k++; return k; }; // line centres: boxes of one line differ by a pixel or two, the next line by a line height
    return [...document.querySelectorAll(${JSON.stringify(sel)})].filter(tr => tr.getClientRects().length).map(tr => ({ name: (tr.querySelector('.dt-primary, .dt-name-text') || tr).textContent.trim().slice(0, 40), lines: lines(tr), h: Math.round(tr.getBoundingClientRect().height) })); })()`;
module.exports = {
    rowLines: (ev, selector) => ev(EXPR(selector)),
    async oneLinePerRow(ev, selector, label, assert, { min = 1 } = {}) {
        const rows = await ev(EXPR(selector));
        assert.ok(rows.length >= min, `${label}: ${rows.length} rows measured (at least ${min})`);
        assert.deepEqual(rows.filter(r => r.lines > 1), [], `${label}: every row is one line (${JSON.stringify(rows)})`);
        return rows;
    },
};
