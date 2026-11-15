/* Up, Down, Home and End between the rows of Needs you (#17226, walks 56 and 79): a person at the keyboard reaches a row's controls with Tab, one row after another; the arrows go to the same control of the row above or below
 * (the same place in the row, or the row's first when it has fewer), Home and End to the first and last row. Loaded by inbox_answer.js (a lazy module, no start bytes); one listener for the page, only on a row of the Needs you table. */
const controls = row => [...row.querySelectorAll('button, a[href], .dt-primary')].filter(b => !b.disabled && !b.classList.contains('dt-star') && b.getBoundingClientRect().width);
if (!window.__coralRowKeys) {
    window.__coralRowKeys = true;
    document.addEventListener('keydown', e => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const table = document.getElementById('group-table-view'), from = e.target instanceof Element && e.target.closest('tbody tr[data-key]');
        if (!table || !from || !table.contains(from) || table.dataset.group !== 'hub-inbox:needs' || e.target.closest('[role="menu"], [role="listbox"], input, select, textarea, [contenteditable]')) return;
        const rows = [...table.querySelectorAll('tbody tr[data-key]')].filter(r => r.getBoundingClientRect().height), at = rows.indexOf(from);
        if (at < 0) return;
        const to = rows[e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))], own = controls(from), same = controls(to);
        const spot = Math.max(0, own.indexOf(e.target.closest('button, a[href], .dt-primary'))), next = same[Math.min(spot, same.length - 1)];
        if (!next) return;
        e.preventDefault();
        next.focus();
    });
}
