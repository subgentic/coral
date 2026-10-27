/* The artifact columns shared by Inbox, team, agent, task and goal lists (#8931).
 * Complete lists sort locally. Paged lists ask the server for the order, every column in both directions (#8945: name, type, tags, size, updated). */
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
/** The server's word for a sort (the team lists' sort=): name, type and tags A to Z and _desc, size largest first and size_asc, updated newest and oldest. */
export function serverArtifactSort(s = artifactSort()) {
    const desc = s.dir === 'desc';
    if (s.key === 'name' || s.key === 'type' || s.key === 'tags') return desc ? `${s.key}_desc` : s.key;
    if (s.key === 'size') return desc ? 'size' : 'size_asc';
    return s.dir === 'asc' ? 'oldest' : 'newest';
}
/** The other way: a server word (the Filters panel's Sort) as the table's sort, so its header marks the same order. */
export function tableSortOf(word) {
    const m = /^(name|type|tags)(_desc)?$/.exec(word);
    if (m) return { key: m[1], dir: m[2] ? 'desc' : 'asc' };
    if (word === 'size' || word === 'size_asc') return { key: 'size', dir: word === 'size' ? 'desc' : 'asc' };
    return { key: 'updated', dir: word === 'oldest' ? 'asc' : 'desc' };
}
export function artifactTable(cfg) {
    const state = cfg.state || DT.tableState();
    if (cfg.groupBy && !state.sortTouched) state.sort = null; // a grouped list keeps its groups (a head per task or goal, its files together) until a header is pressed: DataTable draws heads only while it is unsorted
    else state.sort ||= artifactSort();
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
        ...(cfg.afterName || []), // the Inbox's list spans teams and computers: its Team (or Server) column, which drops with the optional ones
        { key: 'type', label: 'Type', width: '6.5rem', dropAt: 36, tone: 'tertiary', sort: true, sortValue: typeText, cell: i => isUnverified(i) ? '—' : DT.tag(typeText(i)) },
        { key: 'tags', label: 'Tags', width: '16rem', dropAt: cfg.tagsDropAt || 52, sort: true, sortValue: i => (i.tags || []).join(', '), cell: i => Tags.rowTags(i.tags) || '—' },
        { key: 'size', label: 'Size', width: '5rem', dropAt: 28, tone: 'tertiary', sort: 'number', firstDir: 'desc', sortValue: i => Number(i.size) || 0, align: 'end', cell: i => isUnverified(i) ? '—' : sizeText(i.size) || '—' },
        { key: 'updated', label: 'Updated', width: '7.5rem', tone: 'tertiary', sort: 'date', firstDir: 'desc', sortValue: i => i.updated_at || i.created_at, cell: i => DT.timeCell(i.updated_at || i.created_at) },
        ...(cfg.details ? [{ key: 'details', label: 'Details', hideLabel: true, width: '3.75rem', cell: cfg.details }] : []),
    ];
    const table = DT.dataTable({ ...cfg, columns, state, oneLine: true, resize: false, sortBar: false,
        rowKey: cfg.rowKey || itemKey, rowName: i => Tags.nameWithTags(readableName(i), i.tags),
        ...(cfg.paged ? { onSort: (key, dir) => {
            state.sort = { key, dir };
            browserLocal.set(SORT_KEY, JSON.stringify(state.sort)); cfg.onPageSort?.(serverArtifactSort(state.sort));
        } } : {}),
    });
    table.el.classList.add('artifact-table');
    // DataTable changes the state before the event bubbles here, preserving its keyboard focus handling.
    table.el.addEventListener('click', e => { if (e.target.closest('.dt-sort')) { state.sortTouched = true; browserLocal.set(SORT_KEY, JSON.stringify(state.sort)); } });
    return table;
}
