/* Saved as one list in the Inbox's row (#20508): files and messages together, newest saved first. Each row is the Needs you row's shape (a tile, the sender and team line, the words in a 4-line preview, the buttons under them), so it takes the Inbox's own css (.inbox-needs-results). Lazy: the Inbox loads it when Saved opens.
 * entries: [{ kind: 'file', at, a } | { kind: 'message', at, f }], already in order. The Inbox hands in what it owns (inbox_sidebar.js is loaded through importOnce, which a lazy module may not import). */
export function fillSavedList(host, entries, { DT, decorateMessage, decorateKindRow, addStar, fileTile, messageTile, fileActions, messageActions, openFile, openMessage, fileFrom, fileWords, shown }) {
    const tile = e => (e.kind === 'file' ? fileTile(e.a) : messageTile());
    const nameOf = e => (e.kind === 'file' ? shown(e.a) : e.f.which), shownOf = e => (e.kind === 'file' ? shown(e.a) : e.f.title || e.f.which); // a message's button is named by the whole words, as before ("Agent, the words"); the row draws the sender
    const table = DT.dataTable({ label: `Saved, ${entries.length}`, compact: true, bare: true, fold: 'always', rows: entries, rowKey: e => (e.kind === 'file' ? `file:${e.a.reviewKey}` : `msg:${e.f.id}`), rowName: nameOf, sortBar: false,
        open: e => (e.kind === 'file' ? openFile(e.a) : openMessage(e.f.id)),
        decorate: (e, tr) => {
            decorateKindRow(tr);
            if (e.kind === 'file') addStar(e.a, tr);
            tr.classList.add('inbox-kind-row', ...(tr.classList.contains('dt-mailed') ? [] : ['inbox-card-tr']), e.kind === 'file' ? 'inbox-file-row' : 'inbox-saved-message-row');
            tr.querySelector('td[data-key="review"]')?.classList.add('inbox-v4-footer');
            decorateMessage({ review: e.kind === 'file' ? e.a : null }, tr);
            if (tr.classList.contains('dt-mailed')) tr.querySelectorAll('.inbox-preview-toggle').forEach(n => n.remove()); // a phone's whole row is the open button (its name is the words): a Show all inside it would be a button in a button, and the tap opens the whole message
            for (const more of tr.querySelectorAll('.inbox-preview-toggle')) { const label = () => more.setAttribute('aria-label', `${more.textContent}: ${nameOf(e)}`); label(); more.addEventListener('click', label); } // two rows' Show all are not one name
        },
        mail: e => ({ lead: { icon: e.kind === 'file' ? 'description' : 'chat_bubble_outline', square: true, name: e.kind === 'file' ? 'File' : 'Message' }, title: shownOf(e), snippet: (e.kind === 'file' ? fileWords(e.a) : e.f.snip) || '', time: e.when, team: e.team, teamAlways: true, data: e.kind === 'file' ? { reviewArtifact: e.a.id } : { id: String(e.f.id) }, extra: (() => { const box = DT.el('span', 'inbox-saved-extra'), news = e.kind === 'file' && e.a.new_comments > 0 ? DT.tag('New comments') : null; if (news) box.append(news); box.append(e.kind === 'file' ? fileActions(e.a) : messageActions(e.f)); return box; })() }), // a phone's row: the sender, the words and the buttons under them, as the Inbox's
        columns: [
            { key: 'agent', label: 'Item', primary: true, width: 'grow', line: 1, cell: e => {
                const wrap = DT.el('span', 'inbox-review-item inbox-agent-first'), name = DT.primaryButton(shownOf(e), `Open ${nameOf(e)}`), meta = DT.el('span', 'inbox-meta');
                name.classList.add('inbox-review-name');
                if (e.kind === 'message' && e.f.title && e.f.which.startsWith(`${e.f.title}, `)) name.append(DT.el('span', 'sr-only', `, ${e.f.which.slice(e.f.title.length + 2)}`)); // the button still reads the whole words
                const words = e.kind === 'file' ? fileWords(e.a) : e.f.snip;
                if (e.kind === 'file') meta.append(DT.el('span', 'inbox-kind inbox-kind-file', 'Saved file'), fileFrom(e.a)); else meta.append(DT.el('span', 'inbox-kind', 'Saved message'));
                wrap.append(name, meta); if (words) wrap.append(DT.el('span', 'inbox-row-words', words));
                if (e.kind === 'file' && e.a.new_comments > 0) meta.append(DT.tag('New comments'));
                wrap.prepend(tile(e));
                return wrap; } },
            { key: 'team', label: 'Team', width: 'content', line: 1, cell: e => e.team || '' },
            { key: 'waiting', label: 'Saved', tone: 'tertiary', align: 'end', width: 'content', line: 1, cell: e => e.when },
            ...(entries.some(e => e.kind === 'message' && e.f.gone) ? [{ key: 'state', label: 'State', width: 'content', line: 1, cell: e => (e.kind === 'message' && e.f.gone ? DT.tag('Gone') : '') }] : []), // a message that is gone says so (its page says why)
            { key: 'review', label: 'Actions', fixed: true, align: 'end', width: '15rem', line: 3, cell: e => (e.kind === 'file' ? fileActions(e.a) : messageActions(e.f)) },
        ] }).el;
    host.replaceChildren(table);
}
