/* The Inbox's source identity and shared Server controls. No requests run at module load. */
import { state } from './state.js';
import { splitKey, serverRead, identityKey } from './server_base.js';
export const serverChoices = () => ['local', ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local').map(s => s.id) : [])];
export const multipleServers = () => !!state.hub && serverChoices().length > 1;
export const inboxSources = () => ['local', ...new Set(state.hub ? (state.servers || []).filter(s => s.id && s.id !== 'local' && s.status === 'online').map(s => s.id) : [])];
/** The registered computers the hub already knows are not answering (status not online): left out of every merged list, so each folder's quiet line names them too (#8904). */
export const offlineSources = () => (state.hub ? (state.servers || []).filter(s => s && s.id && s.id !== 'local' && s.status !== 'online') : []);
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
    // A registered computer that does not answer in time (or fails) is left out and named in `down`: the reachable computers' files show at once (#8904). This computer failing is the page's error.
    const results = await Promise.all(sources.map(async server => { try { return await readSource(server); } catch (e) {
        if (server === 'local' || (signal && signal.aborted)) throw e;
        return { server, failed: true, label: serverLabel(server), reason: e && e.timedOut ? 'did not answer' : (e && e.message) || 'failed', ...(cursors[server] ? cursors[server] : {}), artifacts: [], teams: [] };
    } }));
    async function readSource(server) {
        const prior = cursors[server];
        if (prior?.done) return { ...prior, server, artifacts: [] };
        const query = new URLSearchParams(params); query.delete('cursor');
        if (team) query.set('team', team.name);
        if (prior?.cursor) query.set('cursor', prior.cursor);
        else query.set('offset', String(prior?.offset || 0));
        const response = await serverRead(server, `/api/team-artifacts?${query}`, { signal });
        if (!response.ok) throw new Error(`${serverLabel(server)} artifacts could not be read (${response.status}).`);
        const data = await response.json();
        if (!Array.isArray(data.artifacts)) throw new Error('Unable to load artifacts: unexpected response.');
        return { ...data, server, artifacts: data.artifacts.map(row => ({ ...row, server, board_id: identityKey(server, row.board_id) })),
            teams: (data.teams || []).map(row => ({ ...row, board_id: identityKey(server, row.board_id) })),
            offset: (prior?.offset || 0) + data.artifacts.length, cursor: data.next_cursor || '', done: !data.has_more };
    }
    const next = Object.fromEntries(results.map(({ artifacts, ...data }) => [data.server, data]));
    return { artifacts: results.flatMap(d => d.artifacts), teams: results.flatMap(d => d.teams || []),
        all: results.reduce((n,d) => n + (d.all || 0), 0), total: results.reduce((n,d) => n + (d.total || 0), 0),
        tag_counts: results.reduce((counts,d) => { for (const [tag,n] of Object.entries(d.tag_counts || {})) counts[tag] = (counts[tag] || 0) + n; return counts; }, Object.create(null)),
        has_more: results.some(d => !d.failed && !d.done), down: [...results.filter(d => d.failed).map(d => ({ server: d.server, label: d.label })), ...offlineSources().filter(s => (!multipleServers() || !filters.server || filters.server === s.id) && (!team || team.server === s.id)).map(s => ({ server: s.id, label: serverLabel(s.id) }))], next_cursor: JSON.stringify(next), truncated: results.some(d => d.truncated) };
}
