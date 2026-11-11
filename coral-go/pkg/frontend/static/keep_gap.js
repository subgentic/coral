/* A box that grows under its messages pushes them up (#15401): when the box gets taller by some pixels the messages scroll by as many, so the text just above the box stays just above it (the box does not cover it), and when it gets shorter they scroll back. Pinned at the bottom stays pinned. Only a change of the box's own height moves the view (not a button or a note appearing, not the box being shown or hidden). It works from the last scroll position seen, not the current one: when the box gets shorter the browser has already pulled a bottom-pinned position back, and counting from that would take the change off twice. */
export function keepGap(scroller, box) {
    if (!scroller || !box || scroller._keepGap || typeof ResizeObserver !== 'function') return;
    let h = scroller.clientHeight, hb = box.offsetHeight, top = scroller.scrollTop;
    scroller.addEventListener('scroll', () => { top = scroller.scrollTop; }, { passive: true });
    scroller._keepGap = new ResizeObserver(() => {
        const n = scroller.clientHeight, nb = box.offsetHeight;
        if (nb && hb && nb !== hb && n !== h) scroller.scrollTop = top + h - n; // the box changed (not shown or hidden) and the messages got shorter or taller with it
        h = n; hb = nb;
    });
    scroller._keepGap.observe(scroller); scroller._keepGap.observe(box);
}
keepGap(document.getElementById('live-history-messages'), document.getElementById('command-input')); // the agent chat: loaded the first time its box changes size in chat mode (command_autosize.js)
