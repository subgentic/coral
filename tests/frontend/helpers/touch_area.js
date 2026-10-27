// What a finger hits (#9332, UI/UX's spec): a dense glyph control (.btn-icon.btn-xs, the (i) buttons) is a 24 px box with a 44 px hit area, a transparent, positioned ::after of the control (centred by its own offsets: inset -10px). Every suite that asks "is this
// control touch-sized" measures this area, not the box: TOUCH_AREA is a page expression (e => { l, t, r, b, w, h, after }) that answers with the ::after's rectangle when the control has one (and says so in `after`), else its box;
// TOUCH_AFTER (e => boolean) is "the ::after is the target and it is 44 px or more". Interpolate them into a page expression: `(${TOUCH_AREA})(el)`.
const TOUCH_AREA = `(e => { const r = e.getBoundingClientRect(); let l = r.left, t = r.top, w = r.width, h = r.height, after = false; const a = getComputedStyle(e, '::after');
    // the ::after is the target only when it is positioned against the control (a positioned control), invisible, and bigger than the box on both axes; its place is its own offsets, not an assumption that it is centred
    if (a.content !== 'none' && a.position === 'absolute' && getComputedStyle(e).position !== 'static' && a.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(a.width) > w && parseFloat(a.height) > h) {
        const aw = parseFloat(a.width), ah = parseFloat(a.height), ox = parseFloat(a.left), oy = parseFloat(a.top);
        if (Number.isFinite(ox) && Number.isFinite(oy)) { l = r.left + e.clientLeft + ox + (parseFloat(a.marginLeft) || 0); t = r.top + e.clientTop + oy + (parseFloat(a.marginTop) || 0); w = aw; h = ah; after = true; } }
    return { l, t, r: l + w, b: t + h, w, h, after }; })`;
const TOUCH_AFTER = `(e => { const a = (${TOUCH_AREA})(e); return a.after && a.w >= 43.5 && a.h >= 43.5; })`;
// how far the control's own ::after hit area sticks out below its box (0 without one): a scroll-height test must not count it as text that spills
const AFTER_OVERHANG = `(e => { const a = (${TOUCH_AREA})(e); return a.after ? (a.h - e.getBoundingClientRect().height) / 2 : 0; })`;
module.exports = { TOUCH_AREA, TOUCH_AFTER, AFTER_OVERHANG };
