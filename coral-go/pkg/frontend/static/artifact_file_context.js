/* Snapshot only the originating list's loaded files, in the order the person sees. */
export function fileContext(items, current, { key, options, opener } = {}) {
    let ordered = items;
    const table = opener?.closest?.('.dt-wrap, table');
    if (table) {
        const rank = new Map([...table.querySelectorAll('tr[data-key]')].map((r, i) => [r.dataset.key, i]));
        if (rank.size) ordered = items.filter(r => rank.has(String(key(r)))).sort((a, b) => rank.get(String(key(a))) - rank.get(String(key(b))));
    }
    const entries = ordered.map(item => ({ item, opts: options(item) })).filter(x => /^[a-f0-9]{64}$/i.test(x.opts?.hex || ''));
    const fileIndex = entries.findIndex(x => key(x.item) === key(current));
    return fileIndex < 0 ? {} : { fileList: entries.map(x => x.opts), fileIndex };
}
