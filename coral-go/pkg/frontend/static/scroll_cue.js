/* The cue of a row that scrolls sideways (#9377): data-more says which edges hide more (end, start, both) and the stylesheet fades that edge. It is drawn again when the row
 * scrolls and when the row or one of its children changes size, which is what a change of text size does (a window resize event does not come for it): at 200% text the row's
 * tabs grew past the edge and nothing said so. Returns the function that draws it, for a caller that adds or removes a child. */
export function watchScrollCue(row) {
    const mark = () => {
        const start = row.scrollLeft > 1, end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
        const v = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
        if (v) row.setAttribute('data-more', v); else row.removeAttribute('data-more');
    };
    row.addEventListener('scroll', mark, { passive: true });
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(mark);
        ro.observe(row);
        for (const child of row.children) ro.observe(child);
    }
    requestAnimationFrame(mark);
    return mark;
}
