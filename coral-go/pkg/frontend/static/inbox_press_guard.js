// #16616: do not navigate or answer a different card after the Inbox reflows during a press.
let press = null;
const control = target => target?.closest?.('a, button, input, select, [role="button"], [data-on-click]');
document.addEventListener('pointerdown', e => {
    press = null;
    if (e.button !== 0 || e.isPrimary === false || document.body.dataset.navTab !== 'hub-inbox') return;
    const node = control(e.target);
    if (node && node.closest('#group-table-view, .team-needs-body')) {
        const box = node.getBoundingClientRect();
        press = { node, x: box.x, y: box.y, at: e.timeStamp };
    }
}, true);
document.addEventListener('pointercancel', () => { press = null; }, true);
document.addEventListener('click', e => {
    const held = press; press = null;
    if (!held || !e.detail || e.timeStamp - held.at > 1500) return; // keyboard and programmatic activation keep their ordinary behavior
    const box = held.node.getBoundingClientRect();
    if (!held.node.isConnected || control(e.target) !== held.node || Math.abs(box.x - held.x) > 4 || Math.abs(box.y - held.y) > 4) {
        e.preventDefault(); e.stopImmediatePropagation();
    }
}, true);
