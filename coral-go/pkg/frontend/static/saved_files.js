/* "Files for review" at the top of Saved (#11641): the review files the Operator saved for later. Each row keeps Approve, Changes and Deny (the Deny word on a wide screen), and the three dots have "Move to Needs you". Lazy: the Inbox
 * loads it when Saved has such a file. A row opens the file (the viewer), as a Needs you row does. */
/* The Inbox hands it the table and the row's actions, shown(file) (the name with hidden characters written out) and subtitleOf(file) (the question and the sender, as Needs you words them: Security, #11641) (inbox_sidebar.js is loaded through importOnce, which a lazy module may not import). */
export function fillSavedFiles(host, files, { DT, reviewActions, openReview, shown, subtitleOf }) {
    const title = DT.el('h3', 'saved-files-title', 'Files for review');
    const table = DT.dataTable({ label: `Files for review, ${files.length}`, compact: true, rows: files, rowKey: a => a.reviewKey, rowName: a => shown(a),
        open: a => openReview(a),
        columns: [
            { key: 'name', label: 'File', primary: true, width: 'grow', line: 1, cell: a => { const n = (a.earlier || []).length; if (!n) return shown(a); const wrap = DT.el('span', 'inbox-review-item'); wrap.append(shown(a), DT.el('span', 'inbox-review-earlier', `${n} earlier version${n === 1 ? '' : 's'}`)); return wrap; }, subtitle: a => subtitleOf(a) }, // one row per file: the newest, with its older saved versions (#11937)
            { key: 'actions', label: 'Actions', hideLabel: true, fixed: true, align: 'end', width: '26rem', line: 1, cell: a => reviewActions(a, true) },
        ] }).el;
    host.replaceChildren(title, table);
}
