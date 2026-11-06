/* A viewer's source is captured once, before deferred navigation or asynchronous reads (#13838). */
import { state } from './state.js';
import { contextServer, normServer, splitKey, LOCAL_SERVER, isCloud, serverFetch } from './server_base.js';

export function resolveArtifactSource(opts = {}) {
    const explicit = opts.server != null;
    const board = opts.board ? splitKey(opts.board) : null;
    const qualified = !!board && String(opts.board).startsWith('@') && board.name !== String(opts.board);
    if (board && String(opts.board).startsWith('@') && !qualified) throw new Error('This file names a computer that is not available in this page.');
    const server = normServer(explicit ? opts.server : board ? board.server : contextServer());
    const ambiguous = isCloud() || state.hub === true || normServer(contextServer()) !== LOCAL_SERVER || (state.servers || []).some(s => s && normServer(s.id) !== LOCAL_SERVER);
    if (explicit && qualified && server !== board.server) throw new Error('This file names two different computers. Open it from its original team.');
    const snapshot = { ...opts, server, ...(board ? { board: board.name } : {}), sourceNamed: opts.sourceNamed !== false && (explicit || qualified || !ambiguous) };
    if (server !== LOCAL_SERVER && !(state.servers || []).some(s => s && s.id === server)) {
        const error = new Error('This file names a computer that is not available in this page.');
        if (!state.serversKnown) { error.code = 'artifact_inventory_pending'; error.source = snapshot; }
        throw error;
    }
    return snapshot;
}

let inventoryRead = null;
/** One authoritative registry read, shared by clicks during startup. Never probe an unlisted computer. */
export function loadArtifactInventory() {
    if (state.serversKnown) return Promise.resolve();
    if (!inventoryRead) inventoryRead = serverFetch(LOCAL_SERVER, '/api/servers', { cache: 'no-store' }).then(async r => {
        if (!r.ok) throw new Error('The computer list could not be loaded. Please try opening the file again.');
        const data = await r.json(), registryEntries = Array.isArray(data) ? data : data?.servers;
        if (!Array.isArray(registryEntries) || registryEntries.some(s => !s || typeof s.id !== 'string' || !s.id)) throw new Error('The computer list could not be loaded. Please try opening the file again.');
        if (!state.serversKnown) { state.servers = registryEntries; state.serversKnown = true; } // a newer live/feed answer wins
    }).finally(() => { inventoryRead = null; });
    return inventoryRead;
}
