/* Hub removal is on since coral-hub's batch-128 was DEPLOYED (owner:true on the live HTTP/WS server rows and /api/servers, and the Hub half of remove:true on dismiss-wait) and Security read it (#14634).
 * Owner metadata must come from the Hub's live HTTP/WS server rows, never inferred from access; the computer (v2.0.60 and later) still decides what may be removed. */
import { compareVersions, serverVersion, shortVersion } from './server_status.js';

export const HUB_REMOVE_WAIT_DEPLOYED = true;
export function remoteRemoveWaitAllowed(serverId, servers, { cloud, deployed = HUB_REMOVE_WAIT_DEPLOYED } = {}) {
    if (cloud !== true || deployed !== true || !serverId || serverId === 'local' || !Array.isArray(servers)) return false;
    const server = servers.find(row => row?.id === serverId);
    if (server?.owner !== true || server.status !== 'online') return false;
    const order = compareVersions(shortVersion(serverVersion(server)), '2.0.60');
    return order === 0 || order === 1;
}

/** Exact wire contract shared by local and (after deployment) remote removal. */
export function removeWaitRequest(session, server) {
    return { server, path: `/api/sessions/live/${encodeURIComponent(session.name)}/dismiss-wait`, options: {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.session_id, agent_type: session.agent_type, remove: true }),
    } };
}
