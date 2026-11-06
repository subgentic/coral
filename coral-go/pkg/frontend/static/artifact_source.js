/* A viewer's source is captured once, before deferred navigation or asynchronous reads (#13838). */
import { state } from './state.js';
import { contextServer, normServer, splitKey, LOCAL_SERVER, isCloud } from './server_base.js';

export function resolveArtifactSource(opts = {}) {
    const explicit = opts.server != null;
    const board = opts.board ? splitKey(opts.board) : null;
    const qualified = !!board && String(opts.board).startsWith('@') && board.name !== String(opts.board);
    if (board && String(opts.board).startsWith('@') && !qualified) throw new Error('This file names a computer that is not available in this page.');
    const server = normServer(explicit ? opts.server : board ? board.server : contextServer());
    const ambiguous = isCloud() || state.hub === true || normServer(contextServer()) !== LOCAL_SERVER || (state.servers || []).some(s => s && normServer(s.id) !== LOCAL_SERVER);
    if (explicit && qualified && server !== board.server) throw new Error('This file names two different computers. Open it from its original team.');
    if (server !== LOCAL_SERVER && !(state.servers || []).some(s => s && s.id === server)) throw new Error('This file names a computer that is not available in this page.');
    return { ...opts, server, ...(board ? { board: board.name } : {}), sourceNamed: opts.sourceNamed !== false && (explicit || qualified || !ambiguous) };
}
