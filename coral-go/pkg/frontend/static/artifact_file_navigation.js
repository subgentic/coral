/* Navigation within the list that opened the lazy file viewer, independent of versions. */
export function attachFileNavigation(dialog, open) {
    const row = document.createElement('div'); row.className = 'artifact-file-navigation'; row.hidden = true;
    const button = (cls, label, text) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn btn-quiet ${cls}`; b.setAttribute('aria-label', label); b.title = label; b.textContent = text; return b; };
    const prev = button('artifact-file-prev', 'Previous file (Left arrow)', '←');
    const next = button('artifact-file-next', 'Next file (Right arrow)', '→');
    const position = document.createElement('span'); position.className = 'artifact-file-position'; position.setAttribute('role', 'status');
    const help = button('artifact-file-help', 'File navigation keys', '?'); help.setAttribute('aria-expanded', 'false');
    const hint = document.createElement('p'); hint.className = 'artifact-file-help-text'; hint.hidden = true;
    hint.textContent = 'Left / Right: previous / next file. Up / Down: scroll. File keys pause while typing or selecting text. Version buttons change versions of the same file.';
    row.append(prev, position, next, help);
    dialog.querySelector('.artifact-viewer-header').after(row, hint);
    let list = [], index = -1, onClose;
    const move = delta => { const n = index + delta; if (n < 0 || n >= list.length) return; const entry = list[n]; open(entry.hex, { ...entry, fileList: list, fileIndex: n, onClose }); };
    prev.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1));
    help.addEventListener('click', () => { hint.hidden = !hint.hidden; help.setAttribute('aria-expanded', String(!hint.hidden)); });
    dialog.addEventListener('keydown', e => {
        if (row.hidden || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        if (e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]') || dialog.querySelector('.artifact-edit-send-action:not([hidden])')) return;
        if (String(window.getSelection() || '')) return;
        e.preventDefault(); e.stopPropagation(); move(e.key === 'ArrowLeft' ? -1 : 1);
    });
    return opts => {
        list = Array.isArray(opts.fileList) ? opts.fileList : [];
        index = Number.isInteger(opts.fileIndex) ? opts.fileIndex : -1;
        onClose = opts.onClose;
        row.hidden = list.length < 2 || index < 0 || index >= list.length;
        position.textContent = row.hidden ? '' : `${index + 1} of ${list.length}`;
        prev.disabled = index <= 0; next.disabled = index >= list.length - 1;
        hint.hidden = true; help.setAttribute('aria-expanded', 'false');
    };
}
