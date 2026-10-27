/* The Inbox's source identity and shared Server controls. No requests run at module load. */
import { state } from './state.js';
import { splitKey, serverFetch, identityKey, isCloud } from './server_base.js';
/** On a Hub-served dashboard there is no "local" computer: the Hub has no chats or boards of its own, so the sources are the linked computers (online ones for a read; Goal #100). */
export const serverChoices = () => [...(isCloud() ? [] : ['local']), ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local').map(s => s.id) : [])];
export const multipleServers = () => !!state.hub && serverChoices().length > 1;
export const inboxSources = () => [...(isCloud() ? [] : ['local']), ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];
export function serverLabel(id) { return !id || id === 'local' ? 'This computer' : (state.servers || []).find(s => s.id === id)?.label || (state.servers || []).find(s => s.id === id)?.name || id; }
export const serverOf = row => row.server || splitKey(row.project || row.board_id || row.team || '').server || 'local';
export const serverMatches = (row, filters) => !multipleServers() || !filters.server || serverOf(row) === filters.server;
export const serverFilter = { type: 'text', max: 200, chip: value => `Server: ${serverLabel(value)}` };
export const serverField = id => ({ type: 'select', key: 'server', id: `${id}-server`, label: 'Server', values: [], labels: {}, any: 'Any server' });
export function syncServerField(bar) {
    const values = serverChoices();
    bar.setOptions('server', values, Object.fromEntries(values.map(id => [id, serverLabel(id)])));
    bar.showField('server', multipleServers());
}
export const serverColumns = () => multipleServers() ? [{ key: 'server', label: 'Server', sort: true, sortValue: row => serverLabel(serverOf(row)), line: 2, cell: row => serverLabel(serverOf(row)) }] : [];

/** Each source owns its cursor. Never send one machine's cursor or team key to another. */
export async function readInboxArtifacts(params, filters = {}, signal) {
    let cursors = {};
    try {
        const parsed = JSON.parse(params.get('cursor') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            Object.values(parsed).every(value => value && typeof value === 'object' && !Array.isArray(value))) cursors = parsed;
    } catch { /* Old single-source or malformed cursors restart each source from the top. */ }
    const team = filters.team ? splitKey(filters.team) : null;
    const sources = inboxSources().filter(id => (!multipleServers() || !filters.server || filters.server === id) && (!team || team.server === id));
    const results = await Promise.all(sources.map(async server => {
        const prior = cursors[server];
        if (prior?.done) return { ...prior, server, artifacts: [] };
        const query = new URLSearchParams(params); query.delete('cursor');
        if (team) query.set('team', team.name);
        if (prior?.cursor) query.set('cursor', prior.cursor);
        else query.set('offset', String(prior?.offset || 0));
        const response = await serverFetch(server, `/api/team-artifacts?${query}`, { signal });
        if (!response.ok) throw new Error(`${serverLabel(server)} artifacts could not be read (${response.status}).`);
        const data = await response.json();
        if (!Array.isArray(data.artifacts)) throw new Error('Unable to load artifacts: unexpected response.');
        return { ...data, server, artifacts: data.artifacts.map(row => ({ ...row, server, board_id: identityKey(server, row.board_id) })),
            teams: (data.teams || []).map(row => ({ ...row, board_id: identityKey(server, row.board_id) })),
            offset: (prior?.offset || 0) + data.artifacts.length, cursor: data.next_cursor || '', done: !data.has_more };
    }));
    const next = Object.fromEntries(results.map(({ artifacts, ...data }) => [data.server, data]));
    return { artifacts: results.flatMap(d => d.artifacts), teams: results.flatMap(d => d.teams || []),
        all: results.reduce((n,d) => n + (d.all || 0), 0), total: results.reduce((n,d) => n + (d.total || 0), 0),
        tag_counts: results.reduce((counts,d) => { for (const [tag,n] of Object.entries(d.tag_counts || {})) counts[tag] = (counts[tag] || 0) + n; return counts; }, Object.create(null)),
        has_more: results.some(d => !d.done), next_cursor: JSON.stringify(next), truncated: results.some(d => d.truncated) };
}
