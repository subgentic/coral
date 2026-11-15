/* Device-local Stop intent, scoped to the server and terminal, never to a display name. */
import { sessionServer } from './server_base.js';
const stopped = new Set();
const key = row => JSON.stringify([sessionServer(row), row.session_id]);
export const wasStopped = row => !!row?.session_id && stopped.has(key(row));
export function markStopped(row, value) {
    if (!row?.session_id) return;
    if (value) stopped.add(key(row)); else stopped.delete(key(row));
}
