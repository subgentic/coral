/** The one line a table held under a resting pointer shows (sidebar_groups.js, #15339): "2 new waiting. Show". Lazy: it is drawn only while a redraw is held (#22108, start JS). show(p) is the Show button's action. */
export function drawHeldNote(n, show) {
    const host = document.getElementById('group-table-view');
    let p = host.querySelector('.group-table-held');
    if (!p) { p = document.createElement('p'); p.className = 'item-meta group-table-held'; p.setAttribute('role', 'status'); host.append(p); }
    const b = document.createElement('button'); b.className = 'btn btn-small btn-quiet'; b.textContent = 'Show';
    b.onclick = () => show(p);
    p.replaceChildren(`${n || 'Some'} new waiting. `, b);
}
