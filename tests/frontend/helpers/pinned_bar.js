// The one rule of every pinned bar (#7684, UI/UX's 170 consistency list, item 1): the buttons are right-aligned, the secondary ones first, the primary (btn-primary or btn-success) last at the right, and a
// danger button (btn-danger) alone at the left edge, first in the order too. `pinnedBarProbe(selector)` is page code (a string for ev): it says what the bar on screen does; `assertPinnedBar` checks it.
const assert = require('node:assert/strict');

const pinnedBarProbe = selector => `(() => {
    const bar = document.querySelector(${JSON.stringify(selector)});
    if (!bar || !bar.getClientRects().length) return null;
    const cs = getComputedStyle(bar), br = bar.getBoundingClientRect();
    const btns = [...bar.querySelectorAll('button.btn, a.btn, .btn')].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && !b.closest('[hidden], .wf-more-menu, .sched-more-menu'));
    const rect = b => b.getBoundingClientRect();
    const primary = btns.filter(b => b.matches('.btn-primary, .btn-success'));
    const danger = btns.filter(b => b.matches('.btn-danger'));
    const rows = new Set(btns.map(b => Math.round(rect(b).top))).size;
    const rightEdge = Math.max(...btns.map(b => rect(b).right)), leftEdge = Math.min(...btns.map(b => rect(b).left));
    const contentRight = br.right - parseFloat(cs.paddingRight || 0), contentLeft = br.left + parseFloat(cs.paddingLeft || 0);
    return { names: btns.map(b => b.textContent.trim().replace(/\\s+/g, ' ')), rows,
        rightAligned: rightEdge >= contentRight - 2,
        primaryLast: primary.length === 0 || (primary.length === 1 && rect(primary[0]).right >= rightEdge - 1 && btns[btns.length - 1] === primary[0]),
        dangerFirst: danger.length === 0 || (danger.length === 1 && btns[0] === danger[0] && rect(danger[0]).left <= contentLeft + 2),
        dangerAlone: danger.length === 0 || btns.length === 1 || rect(btns[1]).left - rect(danger[0]).right > 24 || rows > 1 };
})()`;

/** Asserts the bar matched by `selector` follows the rule; `ev` is the suite's page evaluator; `what` names the page in the message. */
async function assertPinnedBar(ev, selector, what) {
    const r = await ev(pinnedBarProbe(selector));
    assert.ok(r, `${what}: the pinned bar (${selector}) is on screen`);
    assert.ok(r.names.length > 0, `${what}: the bar has buttons`);
    assert.ok(r.rightAligned || r.rows > 1, `${what}: the buttons are at the right: ${JSON.stringify(r)}`);
    assert.ok(r.primaryLast, `${what}: the primary is the last button, at the right: ${JSON.stringify(r)}`);
    assert.ok(r.dangerFirst, `${what}: a danger button is first, at the left edge: ${JSON.stringify(r)}`);
    assert.ok(r.dangerAlone, `${what}: the danger button is apart from the others: ${JSON.stringify(r)}`);
    return r;
}
module.exports = { pinnedBarProbe, assertPinnedBar };
