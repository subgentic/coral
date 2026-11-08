/* Hub removal remains off until batch-127 is explicitly DEPLOYED. Owner metadata
 * must come from the Hub's live HTTP/WS server rows, never inferred from access. */
import { compareVersions, serverVersion, shortVersion } from './server_status.js';

export const HUB_REMOVE_WAIT_DEPLOYED = false;
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
