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
export const serverFilter = { type: 'text', max: 200, chip: value => `Computer: ${serverLabel(value)}` };
export const serverField = id => ({ type: 'select', key: 'server', id: `${id}-server`, label: 'Computer', values: [], labels: {}, any: 'Any computer' });
export function syncServerField(bar) {
    const values = serverChoices();
    bar.setOptions('server', values, Object.fromEntries(values.map(id => [id, serverLabel(id)])));
    bar.showField('server', multipleServers());
}
export const serverColumns = () => multipleServers() ? [{ key: 'server', label: 'Computer', sort: true, sortValue: row => serverLabel(serverOf(row)), line: 2, cell: row => serverLabel(serverOf(row)) }] : [];

/** The computers that answered 403 owner_only to the artifacts list: this person is a grantee there. Kept for the session, per computer: no later read asks them again. */
const ownerOnly = new Set();
const emptyArtifacts = server => ({ server, artifacts: [], teams: [], all: 0, total: 0, offset: 0, cursor: '', done: true, ownerOnly: true });
const isOwnerOnlyAnswer = async response => { const body = await response.clone().json().catch(() => ({})); return body.code === 'owner_only' || body.error === 'owner_only'; };
/** True when there is at least one online computer and every one of them refused: the Hub-served Inbox then has no Artifacts folder. With one that allows it, the folder lists that computer's artifacts. */
export const artifactsOwnerOnlyEverywhere = () => { const sources = inboxSources(); return sources.length > 0 && sources.every(server => ownerOnly.has(server)); };

/** Each source owns its cursor. Never send one machine's cursor or team key to another.
 *  One computer failing does not fail the folder (#12672): every computer is read on its own (allSettled), the ones that answered are shown, and the answer names the ones that did not (`failed`) so the page can
 *  say so once, with a Retry. `answered` and `expected` say how many computers the headline count is a sum of (a computer that refused owner_only is not expected to answer); `versionless` names the computers that
 *  answered without the versions=newest key (an older Coral), whose `all` counts every version of a file, not files. When nobody could be read it throws; with no computer to ask it says why, never an empty list. */
export async function readInboxArtifacts(params, filters = {}, signal) {
    let cursors = {};
    try {
        const parsed = JSON.parse(params.get('cursor') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            Object.values(parsed).every(value => value && typeof value === 'object' && !Array.isArray(value))) cursors = parsed;
    } catch { /* Old single-source or malformed cursors restart each source from the top. */ }
    const team = filters.team ? splitKey(filters.team) : null;
    const everyone = inboxSources();
    const sources = everyone.filter(id => (!multipleServers() || !filters.server || filters.server === id) && (!team || team.server === id));
    if (!everyone.length && state.hub) { // no computer to ask at all (a filter that names a computer that is not online is not this: it is an empty list, as it always was): the list of computers has not loaded yet (the read is not finished), or none is online (it cannot be read): neither is "no artifacts"
        if (!Array.isArray(state.servers)) return { waiting: true, artifacts: [], teams: [], all: 0, total: 0, tag_counts: Object.create(null), has_more: false, next_cursor: '{}', truncated: false, failed: [], answered: 0, expected: 0, versionless: [] };
        throw new Error('No linked computer is online, so artifacts cannot be read.');
    }
    const settled = await Promise.allSettled(sources.map(async server => {
        const prior = cursors[server];
        if (prior?.done) return { ...prior, server, artifacts: [] };
        if (ownerOnly.has(server)) return emptyArtifacts(server);
        const query = new URLSearchParams(params); query.delete('cursor');
        if (team) query.set('team', team.name);
        if (prior?.cursor) query.set('cursor', prior.cursor);
        else query.set('offset', String(prior?.offset || 0));
        let response = await serverFetch(server, `/api/team-artifacts?${query}`, { signal });
        let versionless = !!prior?.versionless;
        // Only a 400 means "this Coral does not know the key": a 404 is a route that is not there (an older Coral without the list at all), which asking again without the key cannot fix.
        if (response.status === 400 && query.has('versions')) { query.delete('versions'); versionless = true; response = await serverFetch(server, `/api/team-artifacts?${query}`, { signal }); } // an older Coral does not know versions: its list is whole, and its count is of versions
        if (response.status === 403 && await isOwnerOnlyAnswer(response)) { ownerOnly.add(server); return emptyArtifacts(server); } // a grantee on that computer: its artifacts are View plus owner-only, so it a
        if (!response.ok) throw Object.assign(new Error(`${serverLabel(server)} artifacts could not be read (${response.status}).`), { server });
        const data = await response.json();
        if (!Array.isArray(data.artifacts)) throw Object.assign(new Error(`${serverLabel(server)} sent an answer this page does not understand.`), { server });
        return { ...data, server, versionless, artifacts: data.artifacts.map(row => ({ ...row, server, board_id: identityKey(server, row.board_id) })),
            teams: (data.teams || []).map(row => ({ ...row, board_id: identityKey(server, row.board_id) })),
            offset: (prior?.offset || 0) + data.artifacts.length, cursor: data.next_cursor || '', done: !data.has_more };
    }));
    const aborted = settled.find(r => r.status === 'rejected' && r.reason && r.reason.name === 'AbortError');
    if (aborted) throw aborted.reason; // the caller's own cancel is not a computer failing
    const results = [], failed = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') { results.push(r.value); if (r.value.failed) failed.push(r.value.server); return; }
        const server = sources[i];
        failed.push(server);
        results.push({ server, artifacts: [], teams: [], all: 0, total: 0, offset: cursors[server]?.offset || 0, cursor: '', done: true, failed: true }); // kept as unread: a Retry reads the folder again from the top
    });
    const read = results.filter(d => !d.ownerOnly && !d.failed); // the computers whose answer is in the numbers
    const expected = results.filter(d => !d.ownerOnly).length;
    if (expected > 0 && !read.length) {
        const bad = settled.filter(r => r.status === 'rejected').map(r => r.reason);
        throw new Error(bad.length === 1 && failed.length === 1 ? bad[0].message : `Artifacts could not be read from ${failed.map(serverLabel).join(', ')}.`);
    }
    const next = Object.fromEntries(results.map(({ artifacts, ...data }) => [data.server, data]));
    return { artifacts: results.flatMap(d => d.artifacts), teams: results.flatMap(d => d.teams || []),
        all: results.reduce((n,d) => n + (d.all || 0), 0), total: results.reduce((n,d) => n + (d.total || 0), 0),
        tag_counts: results.reduce((counts,d) => { for (const [tag,n] of Object.entries(d.tag_counts || {})) counts[tag] = (counts[tag] || 0) + n; return counts; }, Object.create(null)),
        has_more: results.some(d => !d.done), next_cursor: JSON.stringify(next), truncated: results.some(d => d.truncated),
        failed: [...new Set(failed)], answered: read.length, expected, versionless: results.filter(d => d.versionless).map(d => d.server) };
}
