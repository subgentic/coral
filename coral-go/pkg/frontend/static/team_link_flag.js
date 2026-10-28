/* Whether the Coral Hub shows "Link team..." in a team's menu (#9888, the joint note with coral-hub): the Hub's dark switch (CORAL_HUB_TEAM_LINK_DIALOG, an allow-list of accounts) is the account field
 * team_link_dialog of GET /api/account, a strict boolean read once at load, as artifacts_tab.js reads artifacts_frame. Anything else (false, absent, not a boolean, an error) is off: no item. And the item is
 * for a team only when that team's computer is one of the viewer's OWN: its server id is in the viewer's GET /api/servers (a share grantee viewing someone else's machine has no such row), read once with
 * the flag; a failed read offers nothing. The answers let the list draw the item, so the list is redrawn once when they arrive. Never throws. */
import { redrawLiveList, teamLinkState, teamLinkOffered } from './list_hooks.js';

export { teamLinkOffered }; // the answer the team menu reads lives in list_hooks.js (a startup module); this module, loaded on first use, only fills it

export async function initTeamLinkFlag() {
    let value = false, ids = new Set();
    try {
        const r = await fetch('/api/account', { headers: { Accept: 'application/json' } });
        if (r.ok) { const d = await r.json(); value = !!d && d.team_link_dialog === true; }
        if (value) {
            const s = await fetch('/api/servers', { headers: { Accept: 'application/json' } });
            if (s.ok) { const d = await s.json(); const rows = Array.isArray(d) ? d : (d && Array.isArray(d.servers) ? d.servers : []); ids = new Set(rows.filter(x => x && typeof x.id === 'string').map(x => x.id)); }
        }
    } catch { /* no answer: no item */ }
    const changed = value !== teamLinkState.on || ids.size !== teamLinkState.own.size || [...ids].some(i => !teamLinkState.own.has(i));
    teamLinkState.on = value; teamLinkState.own = ids;
    if (changed) { try { redrawLiveList(); } catch { /* the list is not up yet: it reads the flag when it draws */ } }
    return teamLinkState.on;
}
