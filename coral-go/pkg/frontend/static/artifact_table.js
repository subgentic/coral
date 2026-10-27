/* The artifact columns shared by Inbox, team, agent, task and goal lists (#8931).
 * Complete lists sort locally. Paged lists keep the server's order and supported directions. */
import { browserLocal } from './safe_storage.js';
import { importOnce } from './import_once.js';
const DT = await importOnce('./data_table.js');
const Tags = await importOnce('./artifact_tags.js');
const { fileIconHtml } = await importOnce('./file_explorer.js');
const { readableName, itemKey, sizeText, typeText, isUnverified } = await importOnce('./artifact_item.js');
const SORT_KEY = 'coral-artifact-table-sort';
const keys = ['name', 'type', 'tags', 'size', 'updated'];
export function artifactSort() {
    try { const s = JSON.parse(browserLocal.get(SORT_KEY)); if (keys.includes(s?.key) && ['asc', 'desc'].includes(s.dir)) return s; } catch { /* default */ }
    return { key: 'updated', dir: 'desc' };
}
export function serverArtifactSort(s = artifactSort()) {
    return s.key === 'name' ? 'name' : s.key === 'size' ? 'size' : s.key === 'updated' && s.dir === 'asc' ? 'oldest' : 'newest';
}
export function artifactTable(cfg) {
    const state = cfg.state || DT.tableState();
    state.sort ||= artifactSort();
    if (cfg.paged && cfg.noPageSort) state.sort = { key: 'updated', dir: 'desc' };
    if (cfg.paged) {
        if (['type', 'tags'].includes(state.sort.key)) state.sort = { key: 'updated', dir: 'desc' };
        if (state.sort.key === 'name') state.sort.dir = 'asc';
        if (state.sort.key === 'size') state.sort.dir = 'desc';
    }
    const columns = [
        { key: 'name', label: 'Name', primary: true, width: 'grow', sort: true, sortValue: readableName, cell: item => {
            const b = DT.primaryButton(readableName(item)); b.dataset.artifactId = (cfg.rowKey || itemKey)(item);
            if (cfg.nameTitle) b.title = cfg.nameTitle(item);
            const badge = cfg.nameBadge?.(item);
            const wrap = DT.el('span', 'dt-title-cell');
            // Browse owns the filename mapping and decorative SVG markup.
            const icon = DT.el('span', 'artifact-name-icon');
            icon.innerHTML = fileIconHtml(readableName(item));
            wrap.append(icon, b);
            if (badge) wrap.append(badge);
            return wrap;
        } },
        { key: 'type', label: 'Type', width: '6.5rem', dropAt: 36, sort: !cfg.paged, sortValue: typeText, cell: i => isUnverified(i) ? '—' : DT.tag(typeText(i)) },
        { key: 'tags', label: 'Tags', width: '16rem', dropAt: 52, sort: !cfg.paged, sortValue: i => (i.tags || []).join(', '), cell: i => Tags.rowTags(i.tags) || '—' },
        { key: 'size', label: 'Size', width: '5rem', dropAt: 28, sort: 'number', firstDir: 'desc', sortValue: i => Number(i.size) || 0, align: 'end', cell: i => isUnverified(i) ? '—' : sizeText(i.size) || '—' },
        { key: 'updated', label: 'Updated', width: '7.5rem', sort: 'date', firstDir: 'desc', sortValue: i => i.updated_at || i.created_at, cell: i => DT.timeCell(i.updated_at || i.created_at) },
        ...(cfg.details ? [{ key: 'details', label: 'Details', hideLabel: true, width: '3rem', cell: cfg.details }] : []),
    ];
    const table = DT.dataTable({ ...cfg, columns: cfg.paged && cfg.noPageSort ? columns.map(c => ({ ...c, sort: false })) : columns, state, oneLine: true, resize: false, sortBar: false,
        rowKey: cfg.rowKey || itemKey, rowName: i => Tags.nameWithTags(readableName(i), i.tags),
        ...(cfg.paged ? { onSort: (key, dir) => {
            state.sort = { key, dir: key === 'name' ? 'asc' : key === 'size' ? 'desc' : dir };
            browserLocal.set(SORT_KEY, JSON.stringify(state.sort)); cfg.onPageSort?.(serverArtifactSort(state.sort));
        } } : {}),
    });
    table.el.classList.add('artifact-table');
    // DataTable changes the state before the event bubbles here, preserving its keyboard focus handling.
    table.el.addEventListener('click', e => { if (e.target.closest('.dt-sort')) browserLocal.set(SORT_KEY, JSON.stringify(state.sort)); });
    return table;
}
