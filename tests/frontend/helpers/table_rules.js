// The rules every table built on data_table.js must keep (the operator's #11942, 2026-11-02), as one in-page auditor and the rule checks over what it measures. The auditor only READS the table's DOM
// (.dt-box, th.dt-th, .dt-resize, .dt-grow, .dt-col-unused): it knows nothing of the surface that drew it, so the same function judges a synthetic spec and a live surface.
//   R1 the table fits its panel: no sideways scroll at a desktop width (the box, the page).
//   R2 one elastic column (the primary): exactly one .dt-grow, and it keeps a floor.
//   R3 every column fits its whole header, and no empty column takes room.
//   R4 fixed columns (no handle: Time, Actions, checkbox) keep one width at every window width.
//   R5 resizing: every non-fixed column but the last on show has a handle; its edge goes where the pointer goes: the column gains the drag, the columns on its right give exactly that (down to their floors), the ones on its left stay; the keyboard does the same (#12409).
//   R6 kept widths: widths saved from an earlier visit never make the table overflow.
//   R7 the same for every row mix (the caller runs the mixes) and at 200% text.
//   R8 a phone (under 600 px): folded rows, no handles, no sideways scroll.
//   R9 a row's action buttons sit in the Actions column only, never inside another column (the operator's Dismiss inside Waiting for); a control marked data-display-control (a chart legend's line toggle) and an agent's name link (.agent-link) are not row actions.
// folded below means the header row is not drawn (the class dt-fold-column names the mode, not the state), or the table is a one-line table (dt-one-line: the phone form of a table with no folded second line, #11943)
const AUDIT = `(box) => {
  const vis = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0;
  const ths = [...box.querySelectorAll('thead th.dt-th')];
  const cols = ths.filter(h => h.getClientRects().length > 0).map(h => {
    const key = h.dataset.key || '', r = h.getBoundingClientRect(), t = h.querySelector('.dt-sort > span, .dt-head-text');
    let need = 0, clipped = false;
    if (t) { const g = document.createRange(); g.selectNodeContents(t); need = Math.ceil(g.getBoundingClientRect().width); clipped = t.scrollWidth > t.clientWidth + 1; }
    const cells = [...box.querySelectorAll('tbody tr.dt-row td[data-key="' + key + '"]')];
    const empty = cells.length > 0 && cells.every(td => !td.textContent.trim() && !td.querySelector('button, svg, img, progress, input, .dt-chip, .dt-person, .dt-tag'));
    return { key, label: (t ? t.textContent : h.textContent).trim(), w: Math.round(r.width), need, clipped, empty, grow: h.classList.contains('dt-grow'), unused: h.classList.contains('dt-col-unused'), handle: !!h.querySelector('.dt-resize'), check: h.classList.contains('dt-check') || !!h.querySelector('input[type=checkbox]') };
  }).filter(c => c.w > 0);
  const b = box.getBoundingClientRect(), tb = box.querySelector('table.dt-table'), tr = tb ? tb.getBoundingClientRect() : b;
  const sc = document.scrollingElement;
  const buttons = [...box.querySelectorAll('tbody tr.dt-row td button, tbody tr.dt-row td a.btn')].filter(x => !x.closest('[data-display-control]') /* a display control (a chart legend's line toggle) is not a row action */ && !x.classList.contains('agent-link') /* an agent's name opens that agent's chat: navigation, like the row's own link, not a row action (#12168) */ && !x.classList.contains('dt-primary') && !x.classList.contains('dt-link') && !x.classList.contains('dt-star') && !x.closest('.dt-check-hit') && x.getClientRects().length > 0 && x.closest('td'))
    .map(x => ({ key: x.closest('td').dataset.key || '', text: (x.getAttribute('aria-label') || x.textContent).replace(/\\s+/g, ' ').trim().slice(0, 40) }));
  return { buttons, actionKeys: cols.filter(c => c.key === 'actions' || /^actions?$/i.test(c.label)).map(c => c.key), folded: !box.querySelector('thead') || box.querySelector('thead').getClientRects().length === 0 || /dt-folded|dt-one-line/.test(box.className), panelW: Math.round(b.width), tableW: Math.round(tr.width), boxOver: box.scrollWidth - box.clientWidth, tableOver: Math.round(tr.right - b.right), pageOver: sc.scrollWidth - innerWidth, vw: innerWidth, rows: box.querySelectorAll('tbody tr.dt-row').length, cols };
}`;

/** Judge one measurement (what AUDIT returned) against R1 to R3 and R8; returns the violations as sentences. */
function judge(m, { phone = false, scrollByDesign = false } = {}) {
    const v = [];
    if (phone) {
        if (!m.folded) v.push('R8: under 600 px the rows fold to lines (the table is not folded)');
        if (m.cols.some(c => c.handle)) v.push('R8: no resize handles on a phone (' + m.cols.filter(c => c.handle).map(c => c.key).join(',') + ')');
        if (m.pageOver > 1 || m.boxOver > 1) v.push(`R8: sideways scroll on a phone (page ${m.pageOver}, box ${m.boxOver})`);
        return v;
    }
    if (m.pageOver > 1) v.push(`R1: the page scrolls sideways by ${m.pageOver}px`);
    if (!scrollByDesign && m.boxOver > 1) v.push(`R1: the table box scrolls sideways by ${m.boxOver}px`);
    if (m.tableOver > 1) v.push(`R1: the table is ${m.tableOver}px wider than its panel`);
    if (!m.folded) for (const b of m.buttons || []) if (!(m.actionKeys || []).includes(b.key)) v.push(`R9: the button "${b.text}" sits in the "${b.key}" column, not in Actions`);
    if (!m.folded) {
        const grows = m.cols.filter(c => c.grow);
        if (grows.length !== 1) v.push(`R2: ${grows.length} elastic columns (${grows.map(c => c.key).join(',') || 'none'}); exactly one is the rule`);
        else if (grows[0].w < 120) v.push(`R2: the elastic column ${grows[0].key} is ${grows[0].w}px, below its floor of 120px`);
        for (const c of m.cols) {
            if (c.clipped || c.w < c.need + 8) v.push(`R3: column "${c.label}" is ${c.w}px, narrower than its header (${c.need}px of text)`);
            if (c.empty && !c.unused) v.push(`R3: column "${c.label}" is empty and still takes ${c.w}px`);
        }
    }
    return v;
}

module.exports = { AUDIT, judge };
