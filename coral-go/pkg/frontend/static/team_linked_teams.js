/* The team page's "Linked teams" section (#16011; the Operator via coral-hub: "having the team link outside of the main workflow is not ideal"). A slim section under the team's header, on every tab: this team's links to teams on
 * other computers, in both directions, and the way out to Coral Hub's Team links page to add one. It is drawn only when this computer is linked to a Coral Hub (GET /api/cloud/status says connecting, connected or retrying), for a team
 * of this computer, and only when the team's own state can be read (GET /api/board/{team}/cross-team-state: links = teams that can message this one, links_out = teams this one can message); any other answer draws nothing, so a
 * team without a Hub or a reader without the owner's right sees no empty box. Everything is drawn as text (textContent), never HTML. The Settings > Messaging list is the same data and is left as it is. */
import { splitKey, boardFetch, isCloud } from './server_base.js';

const LINKS_PATH = '/team-links'; // Coral Hub's Team links page, on the Hub this computer is linked to (#16484): its origin only, no path, query or team data
const MAX_LINKS = 50;
const label = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 80); // display text: no control or bidi characters, bounded
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let seq = 0; // the latest draw wins: a slow answer for the team left behind draws nothing

// null when no Hub is linked; else { url }: the Team links page of the linked Hub, or '' when its address is not a usable http(s) one (the rows still show, the link out does not)
async function hubLinked() {
    try {
        const r = await fetch('/api/cloud/status'); if (!r.ok) return null; const st = await r.json();
        if (!['connecting', 'connected', 'retrying'].includes(st && st.state)) return null;
        let url = ''; try { const u = new URL(String(st.hub_url || '')); if (u.protocol === 'https:' || u.protocol === 'http:') url = u.origin + LINKS_PATH; } catch { /* no usable address */ }
        return { url };
    } catch { return null; }
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
    let state = null, hub = null;
    try {
        hub = await hubLinked(); if (!hub) return hide();
        const r = await boardFetch(team, '/cross-team-state');
        if (!r.ok) return hide();
        state = await r.json();
    } catch { return hide(); }
    if (mine !== seq || !state || typeof state !== 'object' || state.linkable === false) return hide();
    const rows = rowsOf(state);
    const head = mk('div', 'team-links-head');
    head.append(mk('h2', 'team-links-h', 'Linked teams'));
    if (hub.url) {
        const a = mk('a', 'update-link', rows.length ? 'Manage in Coral Hub' : 'Link a team in Coral Hub');
        a.href = hub.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.append(mk('span', 'sr-only', ' (opens Coral Hub in a new tab)'));
        head.append(a);
    }
    host.replaceChildren(head);
    if (!rows.length) host.append(mk('p', 'team-links-none', 'No linked teams yet.'));
    else {
        const ul = mk('ul', 'team-links-list');
        for (const l of rows) { const li = mk('li'); li.append(mk('b', '', l.team), mk('span', 'team-links-sub', [l.machine, l.how].filter(Boolean).join(' · '))); ul.append(li); }
        host.append(ul);
    }
    host.hidden = false;
}
