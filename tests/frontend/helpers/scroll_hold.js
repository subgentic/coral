// A list scrolled down and HELD there (#12319): scrollIntoView on a far row, then wait until the scroller is past 100 px and has the same offset on three frames in a row, trying again when a redraw of the list put it back to the
// top in between (a fixed sleep here flaked 3 runs in 15). `rowExpr` is page code for the row; `scrollerExpr` is page code for the element that scrolls. Returns the held offset.
const { framesJs } = require('./wait');
async function holdScroll(ev, scrollerExpr, rowExpr, attempts = 30) {
    for (let i = 0; i < attempts; i++) {
        await ev(`(() => { const tr = ${rowExpr}; if (tr) tr.scrollIntoView({ block: 'center' }); return true; })()`);
        let last = -1, same = 0;
        for (let k = 0; k < 8 && same < 3; k++) {
            await ev(framesJs(2, 500));
            const top = await ev(`Math.round(${scrollerExpr}.scrollTop)`);
            same = top === last && top > 100 ? same + 1 : 0; last = top;
        }
        if (same >= 3) return last;
    }
    throw new Error('the list did not hold a scroll offset past 100 px');
}
// Frames pass, not milliseconds: n animation frames (the restore of a list's place holds it for 60 of them).
const frames = (ev, n) => ev(framesJs(n, Math.max(1000, n * 40)));
module.exports = { holdScroll, frames };
