/* "Skip to message box" (the agents pane's first stop) is offered only while the message box is on screen (#12966, the keyboard audit #12963): on a page with no open agent its target is not displayed, and Enter
 * on it went nowhere. The box's own size is watched, so the link goes when the box does and comes back when an agent is opened; a hidden link is no Tab stop.
 * Its own pane counts too (#15626): at 1280 px and 200% text the sidebar is a rail beside an open agent, the pane is display:none, and the link was still hidden=false (a stop for a screen reader's list of links); the pane is watched with the box. */
export function initSkipLink() {
    const link = document.querySelector('.skip-link'), box = document.getElementById('command-input');
    if (!link || !box) return;
    const pane = link.closest('.sidebar-pane'); // the link's own hidden state cannot say whether its pane is shown, so the pane is read
    const sync = () => { link.hidden = box.getClientRects().length === 0 || (!!pane && pane.getClientRects().length === 0); };
    sync();
    if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(sync); ro.observe(box); if (pane) ro.observe(pane); }
}
