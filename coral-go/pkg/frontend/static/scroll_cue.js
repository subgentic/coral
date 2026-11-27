/* The cue of a row that scrolls sideways (#9377): data-more says which edges hide more (end, start, both) and the stylesheet fades that edge. It is drawn again when the row
 * scrolls and when the row or one of its children changes size, which is what a change of text size does (a window resize event does not come for it): at 200% text the row's
 * tabs grew past the edge and nothing said so. Returns the function that draws it, for a caller that adds or removes a child. */
export function watchScrollCue(row, onResize) {
    const mark = () => {
        const start = row.scrollLeft > 1, end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
        const v = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
        if (v) row.setAttribute('data-more', v); else row.removeAttribute('data-more');
    };
    row.addEventListener('scroll', mark, { passive: true });
    const ro = new ResizeObserver(() => { mark(); if (onResize) onResize(); }); // onResize: a caller's own work on the same size changes, so it needs no second observer
    for (const el of [row, ...row.children]) ro.observe(el);
    requestAnimationFrame(mark);
    return mark;
}
