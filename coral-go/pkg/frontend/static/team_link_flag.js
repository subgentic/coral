/* Whether the Coral Hub shows "Link team..." in a team's menu (#9888, the joint note with coral-hub): the Hub's dark switch (CORAL_HUB_TEAM_LINK_DIALOG, an allow-list of accounts) is the account
 * field team_link_dialog of GET /api/account, a strict boolean read once at load, as artifacts_tab.js reads artifacts_frame. Anything else (false, absent, not a boolean, an error) is off: no item. The
 * answer lets the list draw the item, so the list is redrawn once when it arrives. Never throws. */
import { redrawLiveList } from './list_hooks.js';

let on = false;
export const teamLinkOn = () => on;

export async function initTeamLinkFlag() {
    let value = false;
    try {
        const r = await fetch('/api/account', { headers: { Accept: 'application/json' } });
        if (r.ok) { const d = await r.json(); value = !!d && d.team_link_dialog === true; }
    } catch { /* no answer: no item */ }
    if (value !== on) { on = value; try { redrawLiveList(); } catch { /* the list is not up yet: it reads the flag when it draws */ } }
    return on;
}
