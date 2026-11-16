// #16616: do not navigate or answer a different card after the Inbox reflows during a press.
let press = null;
const control = target => target?.closest?.('a, button, input, select, [role="button"], [data-on-click]');
// What a control is, so a redraw that swaps in an identical one (same label, same data keys) is the same control.
const signature = node => JSON.stringify([
    node.tagName, node.getAttribute('aria-label') || (node.textContent || '').replace(/\s+/g, ' ').trim(),
    Object.entries(node.dataset).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
]);
const near = (node, held) => {
    const box = node.getBoundingClientRect();
    return Math.abs(box.x - held.x) <= 4 && Math.abs(box.y - held.y) <= 4;
};
const same = (node, held) => near(node, held) && signature(node) === held.sig;
document.addEventListener('pointerdown', e => {
    press = null;
    if (e.button !== 0 || e.isPrimary === false || document.body.dataset.navTab !== 'hub-inbox') return;
    const node = control(e.target);
    if (node && node.closest('#group-table-view, .team-needs-body')) {
        const box = node.getBoundingClientRect();
        press = { node, x: box.x, y: box.y, at: e.timeStamp, sig: signature(node), px: e.clientX, py: e.clientY };
    }
}, true);
let redelivery = 0;
// Chrome sends no click at all when the pressed node was replaced mid-press; give an identical same-spot replacement its click.
document.addEventListener('pointerup', e => {
    const held = press;
    if (!held || held.node.isConnected || e.button !== 0 || e.timeStamp - held.at > 1500) return;
    if (Math.hypot(e.clientX - held.px, e.clientY - held.py) > 4) return; // a drag is not a tap
    const target = control(e.target);
    if (!target || target.closest('[data-group-control]') || !same(target, held)) return; // a group heading's tap is taken on the lift by data_table.js
    redelivery = setTimeout(() => { redelivery = 0; if (press === held) { press = null; target.click(); } }, 0);
}, true);
document.addEventListener('pointercancel', () => { press = null; }, true);
document.addEventListener('click', e => {
    clearTimeout(redelivery); redelivery = 0;
    const held = press; press = null;
    if (!held || !e.detail || e.timeStamp - held.at > 1500) return; // keyboard and programmatic activation keep their ordinary behavior
    const target = control(e.target);
    if (!target) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // The pressed node itself, or a redraw's identical replacement at the same spot, keeps the click.
    if (target === held.node ? held.node.isConnected && near(target, held) : same(target, held)) return;
    e.preventDefault(); e.stopImmediatePropagation();
}, true);
