/* "Skip to message box" (the agents pane's first stop) is offered only while the message box is on screen (#12966, the keyboard audit #12963): on a page with no open agent its target is not displayed, and Enter
 * on it went nowhere. The box's own size is watched, so the link goes when the box does and comes back when an agent is opened; a hidden link is no Tab stop. */
export function initSkipLink() {
    const link = document.querySelector('.skip-link'), box = document.getElementById('command-input');
    if (!link || !box) return;
    const sync = () => { link.hidden = box.getClientRects().length === 0; };
    sync();
    if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(box);
}
