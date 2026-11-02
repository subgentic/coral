/** An element in view inside its own scrolling row, and nothing else scrolled. scrollIntoView moves every scrolled ancestor too, so a draw that runs after a person scrolled a list (a poll, a late
 *  count, a title that arrives) pulled it back to the row (#12354, #12357). Use this wherever the call is not a person's own click or jump. */
export function revealSideways(el) {
    if (!el) return;
    const kept = []; for (let e = el.parentElement; e; e = e.parentElement) kept.push([e, e.scrollTop]);
    el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    for (const [e, top] of kept) if (e.scrollTop !== top) e.scrollTop = top;
}
