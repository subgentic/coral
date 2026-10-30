/* Cloud server access policy and cached lookups; independent of the Servers view. */
import { accessBlockedMessage } from './hub_access.js';

export const MODES = ['view', 'interact', 'launch'];

export const MODE_INFO = {
    view: { label: 'View', text: 'Read terminals, chats, files, tasks and boards. Nothing you do here changes anything on the computer.' },
    // What each mode allows, as the route table has it (testdata/cloud_routes.golden, what the connector enforces): pinned by
    // TestDashboardModeTextMatchesTheRouteTable (#4526; this said Interact could kill an agent long after #4274 made it Launch).
    interact: { label: 'Interact', text: 'Also type into running agents, post on boards, change tasks and notes, and rename or archive agents. Agents can run commands, so this can make the computer run code. It can also change a team\'s working mode.' },
    launch: { label: 'Launch', text: 'Also start, stop, sleep, wake and restart agents (one agent or a whole team), browse the computer\'s folders, pause boards, delete board messages and boards, and turn on auto-accept.' },
};

const rank = m => MODES.indexOf(m);

/** The lower of two modes; an unknown or missing local mode does not limit. */
export function lowerMode(a, b) {
    if (rank(b) < 0) return rank(a) < 0 ? 'view' : a;
    if (rank(a) < 0) return b;
    return rank(a) <= rank(b) ? a : b;
}

/** What the owner chose for a server's hub access: view, interact or launch (the hub reads a stored launch as "up to what the computer allows"). An unknown or missing value never widens: view. */
export function accessChoice(s) {
    const m = s && s.access_mode;
    if (m === 'follow') return 'launch'; // an older hub's word for the same thing
    return m === 'launch' || m === 'interact' ? m : 'view';
}

/** The owner's choice as a cap. */
export function hubMode(s) { return accessChoice(s); }

/** What actually applies: the lower of the owner's choice and the machine's announced max; a machine that has not announced counts as View. */
export function effectiveMode(s) {
    return rank(s.local_mode) < 0 ? 'view' : lowerMode(hubMode(s), s.local_mode);
}

/** The most this computer allows, as words for a note: "This computer allows up to Interact; change it in Coral on that computer." Fixed words, never machine text; '' when it allows Launch. */
export function launchNote(s) {
    const local = rank(s.local_mode) >= 0 ? s.local_mode : null;
    if (local && rank(local) < rank('launch')) return `This computer allows up to ${MODE_INFO[local].label}; change it in Coral on that computer (Settings > Network and Hub).`;
    return '';
}

/** "Effective: Interact, limited by this computer" when what applies is lower than the owner's choice, else ''. */
export function effectiveNote(s) {
    const eff = effectiveMode(s);
    return rank(eff) < rank(accessChoice(s)) ? `Effective: ${MODE_INFO[eff].label}, limited by this computer` : '';
}

let _modeCache = { at: 0, byId: null, pending: null };

/** Mark the cached Servers list stale, so the next access lookup asks the hub (after
 *  a mode change, so it applies at once rather than within 15 s). The last list stays
 *  readable by cachedServerAccess until the new one arrives: a dialog drawn from it keeps
 *  its answer instead of flickering to "allowed" while the hub is asked again (#5004). */
export function invalidateServerAccess() { _modeCache = { at: 0, byId: _modeCache.byId, pending: null }; }

async function _serverRow(serverId) {
    const now = Date.now();
    if (!_modeCache.byId || now - _modeCache.at > 15000) {
        _modeCache.pending = _modeCache.pending || fetch('/api/servers', { credentials: 'same-origin', quiet: true })
            .then(r => (r.ok ? r.json() : null))
            .then(d => { _modeCache.byId = d && Array.isArray(d.servers) ? Object.fromEntries(d.servers.map(x => [x.id, x])) : (_modeCache.byId || {}); _modeCache.at = Date.now(); })
            .catch(() => { _modeCache.byId = _modeCache.byId || {}; _modeCache.at = Date.now(); })
            .finally(() => { _modeCache.pending = null; });
        await _modeCache.pending;
    } else if (_modeCache.pending) {
        await _modeCache.pending;
    }
    return (_modeCache.byId && _modeCache.byId[serverId]) || null;
}

/** Whether this tab's account may send interact-level requests to `serverId` right now (the lower of the hub mode and the
 *  machine's own limit). Cached for 15 s; an unknown server or a failed lookup answers true so a lookup problem never
 *  blocks the UI (the hub still enforces). Used to skip background writes a viewer could only get refused. */
export async function serverMayInteract(serverId) {
    const a = await serverAccess(serverId);
    return !a || a.mayInteract;
}

/** What the Cloud Hub lets this account do on `serverId`: {hub, local, effective, limitedBy, mayInteract, label},
 *  or null for an unknown server (a lookup problem never blocks the UI; the hub still enforces). Prefers the hub's own
 *  effective_mode / limited_by when the row carries them. */
export async function serverAccess(serverId) {
    const s = await _serverRow(serverId);
    return s ? _access(s, serverId) : null;
}

/** Whether the Servers list has loaded (even if that load failed or left a server out) and no mode
 *  change has marked it stale since: a failed load counts, it stamps the time and is not retried at once. */
export function serverListSettled() {
    return _modeCache.byId !== null && _modeCache.at !== 0;
}

/** serverAccess from the cached Servers list, without asking the hub: null when the list was not
 *  loaded yet or the server is unknown. For drawing a menu (#3443); serverAccess loads it. */
export function cachedServerAccess(serverId) {
    const s = _modeCache.byId && _modeCache.byId[serverId];
    return s ? _access(s, serverId) : null;
}

function _access(s, serverId) {
    const hub = hubMode(s);
    const local = rank(s.local_mode) >= 0 ? s.local_mode : null;
    const effective = rank(s.effective_mode) >= 0 ? s.effective_mode : effectiveMode(s);
    let limitedBy = s.limited_by === 'hub' || s.limited_by === 'machine' ? s.limited_by : null;
    if (!limitedBy && rank(effective) < rank('launch')) limitedBy = !local || rank(local) < rank(hub) ? 'machine' : 'hub'; // a computer that has not announced is the limit: there is nothing for the owner to raise
    return { hub, local, effective, limitedBy, mayInteract: rank(effective) >= rank('interact'), mayLaunch: rank(effective) >= rank('launch'), label: s.label || serverId };
}


/** Plain-language text for a hub refusal of a proxied request, or '' when it is not one we explain.
 *  `local_mode` = the machine's own Cloud access setting is lower than the hub allows (mode is its
 *  current maximum); `access_mode` / `launch_disabled` = the hub setting is too low. */
export function refusalMessage(status, body, serverName = '') {
    if (status !== 403 || !body || typeof body !== 'object') return '';
    const known = m => (rank(m) >= 0 ? m : null);
    if (body.error === 'local_mode') {
        const m = known(body.mode);
        return accessBlockedMessage({ local: m, effective: m, limitedBy: 'machine', label: serverName }, known(body.required));
    }
    if (body.error === 'access_mode' || body.error === 'launch_disabled') {
        const hub = known(body.hub_mode), local = known(body.local_mode);
        const effective = hub && local ? lowerMode(hub, local) : hub || local;
        const limitedBy = hub && local && rank(local) < rank(hub) ? 'machine' : 'hub';
        return accessBlockedMessage({ hub, local, effective, limitedBy, label: serverName },
            known(body.required) || (body.error === 'launch_disabled' ? 'launch' : null));
    }
    return '';
}

