'use strict';
// What a table's default column sizes should give (#9856, the column sizing design note), as one page expression: SIZING(boxSelector, primaryKey) -> { scroll, name, ch24, shown, widths }
//   scroll   the box scrolls sideways (it must not)
//   name     the primary column's width in px, ch24 what 24 characters are in the row's own font: the name is at least that (a row is never cut to a few letters while a column to its right sits idle)
//   shown    the keys of the columns drawn (an empty column and a dropped one are not), widths their widths
// A column dropped for room (dt-col-tight) or hidden for being empty (dt-col-unused) is not shown.
const SIZING = (boxSelector, primaryKey) => `(() => { const box = document.querySelector(${JSON.stringify(boxSelector)}); if (!box) return null;
    const shown = e => !!e && e.getClientRects().length > 0 && !e.classList.contains('dt-col-tight') && !e.classList.contains('dt-col-unused'),
        ths = [...box.querySelectorAll('thead th.dt-th')].filter(shown), td = box.querySelector('tbody tr td[data-key=${JSON.stringify(primaryKey)}]'), probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:24ch;font:' + getComputedStyle(td).font; td.append(probe); const ch24 = probe.getBoundingClientRect().width; probe.remove();
    const th = ths.find(t => t.dataset.key === ${JSON.stringify(primaryKey)});
    return { scroll: box.scrollWidth > box.clientWidth + 1, ch24: Math.round(ch24), name: th ? Math.round(th.getBoundingClientRect().width) : 0, shown: ths.map(t => t.dataset.key), widths: Object.fromEntries(ths.map(t => [t.dataset.key, Math.round(t.getBoundingClientRect().width)])) }; })()`;
module.exports = { SIZING };
