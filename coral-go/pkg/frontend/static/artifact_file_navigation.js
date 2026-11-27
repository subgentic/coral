/* Navigation within the list that opened the lazy file viewer, independent of versions. */
export function attachFileNavigation(dialog, open) {
    const row = document.createElement('div'); row.className = 'artifact-file-navigation'; row.hidden = true; // in the header row, beside Details (#19771); a phone has Previous and Next in the ⋯ menu instead
    const button = (cls, label, text) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn btn-quiet ${cls}`; b.setAttribute('aria-label', label); b.title = label; b.textContent = text; return b; };
    const prev = button('artifact-file-prev', 'Previous file (Left arrow)', '←');
    const next = button('artifact-file-next', 'Next file (Right arrow)', '→');
    const position = document.createElement('span'); position.className = 'artifact-file-position'; position.setAttribute('role', 'status');
    const help = button('artifact-file-help', 'File navigation keys', '?'); help.setAttribute('aria-expanded', 'false');
    const hint = document.createElement('p'); hint.className = 'artifact-file-help-text'; hint.hidden = true;
    hint.textContent = 'Left / Right: previous / next file. Up / Down: scroll. File keys pause while typing or selecting text. Version buttons change versions of the same file.';
    const keys = document.createElement('p'); keys.className = 'artifact-file-keys'; keys.textContent = 'J / K: next / previous item in the Inbox'; // #21852: the review has no arrows; its keys are said in Details
    const helpWrap = document.createElement('div'); helpWrap.className = 'artifact-file-helpwrap'; helpWrap.append(keys, help, hint); // the keys help lives in Details
    const item = (cls, text) => { const m = document.createElement('button'); m.type = 'button'; m.className = `menu-item ${cls}`; m.setAttribute('role', 'menuitem'); m.textContent = text; m.hidden = true; return m; };
    const prevItem = item('artifact-file-prev-item', 'Previous file'), nextItem = item('artifact-file-next-item', 'Next file');
    row.append(prev, position, next);
    dialog.querySelector('.artifact-viewer-menu').prepend(prevItem, nextItem);
    const note = document.createElement('p'); note.className = 'artifact-file-note'; note.setAttribute('role', 'status'); dialog.append(note); let noteTimer = 0; // the short status line at the first and last item (#21852)
    const say = text => { note.textContent = text; clearTimeout(noteTimer); noteTimer = setTimeout(() => { note.textContent = ''; }, 3000); };
    let list = [], index = -1, onClose;
    const move = delta => { const n = index + delta; if (n < 0 || n >= list.length) { say(delta < 0 ? 'This is the first item in the Inbox' : 'This is the last item in the Inbox'); return; } /* at either end the review stays put and says so (#21852) */ const entry = list[n]; open(entry.hex, { ...entry, fileList: list, fileIndex: n, onClose }); };
    prev.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1)); prevItem.addEventListener('click', () => move(-1)); nextItem.addEventListener('click', () => move(1));
    help.addEventListener('click', () => { hint.hidden = !hint.hidden; help.setAttribute('aria-expanded', String(!hint.hidden)); });
    const blocked = e => e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]') || dialog.querySelector('.artifact-edit-send-action:not([hidden])') || String(window.getSelection() || '');
    dialog.addEventListener('keydown', e => {
        if (row.hidden || !['ArrowLeft', 'ArrowRight'].includes(e.key) || blocked(e)) return;
        e.preventDefault(); e.stopPropagation(); move(e.key === 'ArrowLeft' ? -1 : 1);
    });
    // J / K (#21852): next / previous item of the list the viewer was opened from (the review's keys), heard anywhere on the page while it is open (the focus is not always inside it: it goes to the page when the next item is drawn); never in a field, never with a modifier
    document.addEventListener('keydown', e => {
        if (!['j', 'k'].includes(e.key) || dialog.hidden || list.length < 2 || !(e.target instanceof Element) || blocked(e)) return;
        e.preventDefault(); move(e.key === 'k' ? -1 : 1);
    });
    const update = opts => {
        list = Array.isArray(opts.fileList) ? opts.fileList : [];
        index = Number.isInteger(opts.fileIndex) ? opts.fileIndex : -1;
        onClose = opts.onClose;
        row.hidden = list.length < 2 || index < 0 || index >= list.length;
        position.textContent = row.hidden ? '' : `${index + 1} of ${list.length}`;
        prev.disabled = index <= 0; next.disabled = index >= list.length - 1;
        prevItem.hidden = nextItem.hidden = row.hidden; prevItem.disabled = prev.disabled; nextItem.disabled = next.disabled;
        hint.hidden = true; help.setAttribute('aria-expanded', 'false');
        update.shown = !row.hidden; helpWrap.hidden = row.hidden;
    };
    Object.assign(update, { row, helpWrap, shown: false });
    return update;
}
