/* A box that grows under its messages pushes them up (#15401): when the scroller gets shorter by some pixels it scrolls by as many, so the text just above the box stays just above it (the box does not cover it), and when it gets taller again it scrolls back. Pinned at the bottom stays pinned. */
export function keepGap(scroller) {
    if (!scroller || scroller._keepGap || typeof ResizeObserver !== 'function') return;
    let h = scroller.clientHeight;
    scroller._keepGap = new ResizeObserver(() => { const n = scroller.clientHeight; if (n !== h) { scroller.scrollTop += h - n; h = n; } });
    scroller._keepGap.observe(scroller);
}
