/* One table builder and live-record merge for both Servers sources. Columns/details belong to the source components. */
import { state } from './state.js';

export function liveServer(server) {
    return { ...server, ...((state.servers || []).find(row => row && row.id === server.id) || {}) };
}

export function buildServersTable(DT, options, { rowId, tableClass } = {}) {
    const decorate = options.decorate;
    const table = DT.dataTable({ ...options, decorate: (server, row, detail) => {
        row.id = rowId(server); row.tabIndex = -1;
        decorate?.(server, row, detail);
    } });
    if (tableClass) table.el.querySelector('table').classList.add(tableClass);
    return table.el;
}
