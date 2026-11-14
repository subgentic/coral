/* The team page's "Linked teams" section (#16011; the Operator via coral-hub: "having the team link outside of the main workflow is not ideal"). A slim section under the team's header, on every tab: this team's links to teams on
 * other computers, in both directions, and the way out to Coral Hub's Team links page to add one. It is drawn only when this computer is linked to a Coral Hub (GET /api/cloud/status says connecting, connected or retrying), for a team
 * of this computer, and only when the team's own state can be read (GET /api/board/{team}/cross-team-state: links = teams that can message this one, links_out = teams this one can message); any other answer draws nothing, so a
 * team without a Hub or a reader without the owner's right sees no empty box. Everything is drawn as text (textContent), never HTML. The Settings > Messaging list is the same data and is left as it is. */
import { splitKey, boardFetch, isCloud } from './server_base.js';

const HUB_LINKS_URL = 'https://app.coralhub.dev/team-links'; // Coral Hub's Team links page: a constant, the hub refuses a query on it (the constant of team_cross_team_fields.js)
const MAX_LINKS = 50;
const label = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80); // display text: no control or bidi characters, bounded
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let seq = 0; // the latest draw wins: a slow answer for the team left behind draws nothing

async function hubLinked() {
    try { const r = await fetch('/api/cloud/status'); if (!r.ok) return false; const st = await r.json(); return ['connecting', 'connected', 'retrying'].includes(st && st.state); } catch { return false; }
}
function rowsOf(state) {
    const one = (list, how) => (Array.isArray(list) ? list : []).filter(l => l && typeof l === 'object').map(l => ({
        team: label(l.team_label) || 'a team', machine: label(l.server_label) || (l.server_id ? 'computer ' + label(l.server_id) : ''), how,
    }));
    return [...one(state.links, 'can message this team'), ...one(state.links_out, 'can be messaged by this team')].slice(0, MAX_LINKS);
}

/** Draws the section into host (the team page's slot) for team; empties and hides it whenever there is nothing to say. */
export async function drawLinkedTeams(host, team) {
    if (!host) return;
    const mine = ++seq;
    const hide = () => { if (mine === seq) { host.hidden = true; host.replaceChildren(); } };
    const server = splitKey(team).server;
    if (isCloud() || (server && server !== 'local')) return hide();
    let state = null;
    try {
        if (!(await hubLinked())) return hide();
        const r = await boardFetch(team, '/cross-team-state');
        if (!r.ok) return hide();
        state = await r.json();
    } catch { return hide(); }
    if (mine !== seq || !state || typeof state !== 'object' || state.linkable === false) return hide();
    const rows = rowsOf(state);
    const head = mk('div', 'team-links-head');
    head.append(mk('h2', 'team-links-h', 'Linked teams'));
    const a = mk('a', 'update-link', rows.length ? 'Manage in Coral Hub' : 'Link a team in Coral Hub');
    a.href = HUB_LINKS_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.append(mk('span', 'sr-only', ' (opens Coral Hub in a new tab)'));
    head.append(a);
    host.replaceChildren(head);
    if (!rows.length) host.append(mk('p', 'team-links-none', 'No linked teams yet.'));
    else {
        const ul = mk('ul', 'team-links-list');
        for (const l of rows) { const li = mk('li'); li.append(mk('b', '', l.team), mk('span', 'team-links-sub', [l.machine, l.how].filter(Boolean).join(' · '))); ul.append(li); }
        host.append(ul);
    }
    host.hidden = false;
}
