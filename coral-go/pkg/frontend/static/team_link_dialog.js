/* The Link team dialog (#9888, the joint note with coral-hub, slice 1): one dialog, opened from "Link team..." in a team's menu, for this team's links to teams on OTHER computers. In the Coral Hub-served
 * dashboard (cloud mode) it calls ONLY the Hub's own relay routes, all of them the owner's account session API (cookie, the dashboard's CSRF header, exact origin, JSON; never in the tunnel table, never
 * proxied), and nothing else. A test reads this file and refuses any other path (team_link_dialog_calls.test.mjs):
 *   GET    /api/relay/links          the account's links, both directions (the dialog keeps the ones that name this team)
 *   GET    /api/servers              the account's computers (their label, online state, access mode)
 *   GET    /api/sessions/live        its servers[] carry each computer's version, coral_version, below_minimum and min_coral (they are not on /api/servers)
 *   GET    /api/remote/{id}/api/board/projects   a computer's teams, read through the proxy; a team is named by its generated board id
 *   POST   /api/relay/links          {src_server_id, src_team, dst_server_id, dst_team, both_directions}
 *   DELETE /api/relay/links/{id}     takes effect at once; idempotent
 * On a computer's own dashboard (local mode) there is no route that makes a link (the Hub offers none to a connector): the dialog shows the state this computer holds (its own
 * GET /api/board/{team}/cross-team-state, the one local read) and a
 * "Manage in Coral Hub" button. The states are the Hub's own words, from its data: Active (notice delivered), Not delivered (notice not_delivered), Old-style, create again (legacy). There is no
 * pending or revoked word: the Hub has neither. Everything drawn is text (textContent), never HTML.
 * Paths: every one is a plain string or ONE template literal whose only substitution is encodeURIComponent(...); never built by + (team_link_dialog_calls.test.mjs refuses it).
 * GET /api/sessions/live is read once when the dialog opens, with no query: only its servers[] (id, label, version, coral_version, below_minimum, min_coral) is looked at, sessions[] is ignored and
 * kept nowhere; a failed read means "version unknown" and does not block the form (the Hub enforces its minimum version either way). */
import { splitKey, isCloud, keyLabel } from './server_base.js';
import { importOnce } from './import_once.js';

export const HUB_LINKS_URL = 'https://app.coralhub.dev/team-links'; // the constant of team_cross_team_fields.js: the Hub refuses a query on it
export const NOT_DELIVERED_SENTENCE = "That team isn't on that computer (it may have been deleted). Revoke this link, and link the team again if it was re-created."; // coral-hub Security's exact words (corrected 06:32: a re-created board does not revive a link, links name generated ids)
/** The first release that ships links (the operator, #9875 point 1): a computer on an older one is never a link target, it needs an update; the Hub also caps which computers connect by a minimum version. */
export const LINK_MIN_VERSION = '2.0.3';
export const GENERATED_TEAM_ID = /^b-[0-9a-z]{10}$/; // a Hub link names a team by its generated board id, never by a name

const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pick = (o, ...names) => { for (const n of names) if (o && o[n] != null && o[n] !== '') return o[n]; return ''; };

/** The Hub's word for a link's state, from its data only; '' when the data says none (unavailable). */
export function stateWord(link) {
    if (link && link.legacy) return 'Old-style, create again';
    const n = link && link.notice;
    if (!n || typeof n !== 'object') return '';
    return notDelivered(link) ? 'Not delivered' : 'Active';
}
/** The Hub's notice is { source, target }, each delivered, not_delivered or unavailable: not delivered when either side is not_delivered; unavailable is not a failure. */
export function notDelivered(link) {
    const n = link && link.notice;
    return !!n && typeof n === 'object' && (n.source === 'not_delivered' || n.target === 'not_delivered');
}

/** One link seen from this team: null when it names neither end as this team; else { id, end: {server, team, label}, mayMessageUs, weMayMessage }. */
export function linkRow(link, own) {
    const srcServer = link.src_server_id, dstServer = link.dst_server_id;
    const srcTeam = link.src_team, dstTeam = link.dst_team;
    const weAreSrc = srcServer === own.server && srcTeam === own.team, weAreDst = dstServer === own.server && dstTeam === own.team;
    if (!weAreSrc && !weAreDst) return null;
    const end = weAreSrc
        ? { server: dstServer, team: dstTeam, label: pick(link, 'dst_team_label', 'dst_label') }
        : { server: srcServer, team: srcTeam, label: pick(link, 'src_team_label', 'src_label') };
    return { id: link.id, end, mayMessageUs: weAreDst, weMayMessage: weAreSrc, state: stateWord(link), notDelivered: notDelivered(link) && !link.legacy };
}

/** Rows for this team: each direction is its own link and its own row, with its own Revoke (coral-hub Security, for the Both ways default). */
export function rowsFor(links) { return (Array.isArray(links) ? links : []); }

export const directionWords = (row) => row.mayMessageUs ? 'May message this team' : 'This team may message it';

const versionParts = v => String(v || '').trim().replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
/** Whether a computer is on the linking version or later: a version it does not tell is not enough, and a Hub flag that it is below its minimum is an older one. */
export function meetsLinkVersion(s, known = true) {
    if (!known) return !(s && s.below_minimum === true); // a failed read: the version is unknown and does not block the form; the Hub's own minimum still applies
    const v = s && (s.coral_version || s.version);
    if (typeof v !== 'string' || !v.trim() || (s && s.below_minimum === true)) return false;
    const a = versionParts(v), b = versionParts(LINK_MIN_VERSION);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
}
/** The version fields of GET /api/sessions/live's servers[], by id: nothing else of the answer is looked at, and sessions[] is never touched. */
export function liveVersions(answer) {
    const list = answer && Array.isArray(answer.servers) ? answer.servers : null;
    if (!list) return null; // no answer: the version is unknown
    const by = new Map();
    for (const s of list) if (s && typeof s.id === 'string') by.set(s.id, { version: typeof s.version === 'string' ? s.version.slice(0, 40) : '', coral_version: typeof s.coral_version === 'string' ? s.coral_version.slice(0, 40) : '', below_minimum: s.below_minimum === true, min_coral: typeof s.min_coral === 'string' ? s.min_coral.slice(0, 32) : '' });
    return by;
}
/** GET /api/servers rows with those version fields laid over them (null versions: unknown, rows unchanged). */
export function withVersions(servers, versions) {
    return (Array.isArray(servers) ? servers : []).map(s => { const v = versions && versions.get(s && s.id); return v ? { ...s, ...v } : s; });
}
const candidates = (servers, ownServer) => (Array.isArray(servers) ? servers : []).filter(s => s && s.id && s.id !== ownServer && s.online === true && (s.effective_mode || s.access_mode) !== 'view');
/** The computers a link can name: the account's own, online, not this team's computer, not View-only, on the linking version or later. */
export const pickableComputers = (servers, ownServer, known = true) => candidates(servers, ownServer).filter(s => meetsLinkVersion(s, known));
/** The online computers that would be targets but are too old: shown as needing an update, never as a target. */
export const olderComputers = (servers, ownServer, known = true) => candidates(servers, ownServer).filter(s => !meetsLinkVersion(s, known));

/** A computer's teams a link can name: generated board ids only (a name is not one). */
export function pickableTeams(projects) {
    return (Array.isArray(projects) ? projects : []).map(p => ({ id: String(pick(p, 'project', 'board_id', 'id')), label: String(pick(p, 'board_label', 'label', 'project')) })).filter(t => GENERATED_TEAM_ID.test(t.id));
}

/** The create body for a direction: 'they' (they may message this team), 'we' (this team may message them), 'both'. */
export function createBody(direction, own, other) {
    const here = { server: own.server, team: own.team }, there = { server: other.server, team: other.team };
    const [src, dst] = direction === 'they' ? [there, here] : [here, there];
    return { src_server_id: src.server, src_team: src.team, dst_server_id: dst.server, dst_team: dst.team, both_directions: direction === 'both' };
}

/** What a refused or failed call says, in our words (the Hub answers a refused create with one 404 whatever the reason). */
export function errorWords(status, code) {
    if (status === 429 || code === 'rate_limited') return 'Too many changes just now. Try again in a minute.';
    if (code === 'link_limit') return 'This account has the most links it allows. A Both ways link uses two of them.';
    if (code === 'relay_off') return 'Team linking is turned off for this account in Coral Hub.';
    if (code === 'legacy_board') return "That team has an old-style name and can't be linked. Create it again first.";
    if (status === 0) return 'Could not reach Coral Hub.';
    return 'Could not link. Check that both computers are online and not View-only.';
}

async function call(method, path, body) {
    let r;
    try { r = await fetch(path, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); } catch { return { ok: false, status: 0 }; }
    let data = null;
    try { data = await r.json(); } catch { /* an empty answer */ }
    return { ok: r.ok, status: r.status, data, code: data && typeof data.error === 'string' ? data.error : '' };
}

let dialog = null, escapeBack = null, liveEl = null; // escapeBack: what Escape does while a question is showing (go back to the list); liveEl: the status a done revoke or link is said in
const close = () => { if (dialog && dialog.open) dialog.close(); };
/** The control the keyboard goes back to when the dialog closes: the one it opened from, or, when that was a menu item (the menu is shut by then), that menu's own button (#9892). */
function giveFocusBack(from) {
    let t = from;
    if (!t || !t.isConnected || !t.getClientRects().length) t = from && from.closest ? (from.closest('.sidebar-kebab-wrapper') || from.closest('.overflow-menu'))?.querySelector('.sidebar-kebab-btn, [aria-haspopup]') : null;
    if (t && t.isConnected) t.focus({ preventScroll: true });
}
const announce = (text) => { if (liveEl) liveEl.textContent = text; };

/** Open the dialog for the team `teamKey` (an identity key: a name, or @server/name). opts: { cloud } (the mode; the dashboard's own by default), opener (the control to give the focus back to). */
export async function showTeamLinkDialog(teamKey, opts = {}) {
    const own = (k => ({ server: k.server, team: k.name }))(splitKey(teamKey));
    const cloud = opts.cloud !== undefined ? !!opts.cloud : isCloud();
    if (!dialog) {
        dialog = mk('dialog', 'modal-content dlg-form team-link-dialog');
        dialog.id = 'team-link-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'team-link-title');
        dialog.addEventListener('cancel', (e) => { if (dialog.dataset.busy) e.preventDefault(); else if (escapeBack) { e.preventDefault(); escapeBack(); } }); // Escape does not drop a request in flight, and in a question it goes back to the list (#9892)
        document.body.appendChild(dialog);
    }
    close();
    dialog.replaceChildren();
    // where the keyboard goes back to: the control it opened from; but a menu item has shut its menu and dropped the focus on the page by now, so it is the team's own menu button (found by its Link item's data-board)
    const active = document.activeElement, ownerBtn = (board) => [...document.querySelectorAll('.menu-item[data-on-click="team-link"]')].find(i => i.dataset.board === board)?.closest('.sidebar-kebab-wrapper')?.querySelector('.sidebar-kebab-btn') || null;
    const from = opts.opener || (active && active !== document.body && active.getClientRects().length ? active : ownerBtn(opts.board || teamKey)) || active;
    escapeBack = null;
    const teamName = keyLabel(teamKey);
    const head = mk('div', 'modal-header'); const h = mk('h3', null, 'Link a team'); h.id = 'team-link-title'; head.append(mk('div', 'team-link-title-row'));
    head.firstChild.append(h, mk('span', 'team-link-team', teamName));
    const body = mk('div', 'modal-body team-link-body');
    const foot = mk('div', 'modal-actions modal-footer');
    const closeBtn = mk('button', 'btn team-link-close', 'Close'); closeBtn.type = 'button'; closeBtn.addEventListener('click', close);
    foot.append(closeBtn);
    liveEl = mk('p', 'sr-only team-link-live'); liveEl.setAttribute('role', 'status');
    dialog.append(head, body, foot, liveEl);
    dialog.addEventListener('close', () => giveFocusBack(from), { once: true });
    dialog.showModal();
    if (cloud) await renderCloud(body, own, teamName); else await renderLocal(body, own);
    h.tabIndex = -1; h.focus({ preventScroll: true }); // the dialog's title once its content is in: showModal had put the keyboard on Close, at the bottom (#9892)
}

function say(body, text, cls = 'team-link-note') { const p = mk('p', cls, text); body.append(p); return p; }

async function renderLocal(body, own) {
    body.replaceChildren();
    say(body, 'Links to teams on other computers are made in Coral Hub.');
    const r = await call('GET', `/api/board/${encodeURIComponent(own.team)}/cross-team-state`);
    if (r.ok && r.data) {
        const st = r.data.status && r.data.status.text; if (st) say(body, String(st), 'team-link-state');
        const links = Array.isArray(r.data.links) ? r.data.links : [];
        const list = mk('ul', 'team-link-list');
        for (const l of links) { const li = mk('li', 'team-link-row'); li.append(mk('span', 'team-link-name', String(pick(l, 'team_label', 'team_id') || 'A team')), mk('span', 'team-link-where', String(pick(l, 'server_label', 'server_id')))); list.append(li); }
        if (links.length) body.append(list);
    }
    const a = mk('a', 'btn btn-primary team-link-manage', 'Manage in Coral Hub'); a.href = HUB_LINKS_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
    body.append(a);
}

async function renderCloud(body, own, teamName) {
    const DT = await importOnce('./data_table.js'); // the avatar the team lists draw
    body.replaceChildren(mk('p', 'team-link-note', 'Loading links...'));
    const [links, servers, live] = await Promise.all([call('GET', '/api/relay/links'), call('GET', '/api/servers'), call('GET', '/api/sessions/live')]);
    if (!links.ok) { body.replaceChildren(mk('p', 'team-link-error', 'Could not read the links.')); return; }
    const versions = live.ok ? liveVersions(live.data) : null, versionsKnown = !!versions; // read once, at open (never polled); a failed read is "unknown"
    live.data = null; // sessions[] is not kept
    const serverList = withVersions(servers.ok ? (Array.isArray(servers.data) ? servers.data : (servers.data && servers.data.servers) || []) : [], versions);
    const files = links.data && !Array.isArray(links.data) && links.data.relay_artifacts_available === true ? { on: links.data.relay_artifacts_enabled === true } : null; // account-wide, at the top of the links answer: only a read-only chip
    const nameOf = id => { const s = serverList.find(x => x && x.id === id); return (s && s.label) || 'Another computer'; };
    const seen = d => rowsFor(Array.isArray(d) ? d : (d && d.links) || []).map(l => linkRow(l, own)).filter(Boolean);
    const rows = seen(links.data);
    const draw = (message = '', focusSel = '', said = '', quiet = false) => {
        body.replaceChildren(); escapeBack = null;
        const heading = mk('h4', 'team-link-h', `Teams linked to ${teamName}`); heading.tabIndex = -1;
        body.append(heading, mk('p', 'team-link-hint', 'A link lets one team message the other. It is one way unless it says both.'));
        body.append(mk('h5', 'team-link-group', 'Other computers'));
        if (files) body.append(mk('p', 'team-link-hint', 'Files follow the account setting in Coral Hub.'));
        if (!rows.length) say(body, 'Not linked to any team');
        const list = mk('ul', 'team-link-list');
        for (const row of rows) {
            const li = mk('li', 'team-link-row');
            const who = row.end.label || row.end.team;
            const text = mk('div', 'team-link-text');
            text.append(mk('span', 'team-link-name', who), mk('span', 'team-link-where', `${nameOf(row.end.server)} \u00b7 ${directionWords(row)}`));
            if (row.notDelivered) text.append(mk('span', 'team-link-sentence', NOT_DELIVERED_SENTENCE));
            const filesChip = files ? mk('span', 'chip team-link-files', files.on ? 'Files allowed' : 'No files') : null;
            const state = mk('span', `team-link-state${row.state === 'Active' ? ' is-active' : row.state === 'Not delivered' ? ' is-warn' : ''}`, row.state);
            const revoke = mk('button', 'btn btn-quiet btn-small team-link-revoke', 'Revoke'); revoke.type = 'button';
            revoke.dataset.linkId = String(row.id); revoke.setAttribute('aria-label', `Revoke the link with ${row.end.label || row.end.team} on ${nameOf(row.end.server)}, ${directionWords(row)}${row.state ? `, ${row.state}` : ''}`); // named for the team, the computer, the direction and the state (#9892)
            revoke.addEventListener('click', () => confirmRevoke(row));
            const circle = DT.avatar(who).querySelector('.dt-avatar'); circle.classList.add('team-link-avatar'); // the circle only: the name is in the text beside it
            if (filesChip) li.append(circle, text, filesChip, state, revoke); else li.append(circle, text, state, revoke);
            list.append(li);
        }
        body.append(list);
        form();
        if (message) { const e = mk('p', 'team-link-error', message); e.setAttribute('role', 'alert'); body.append(e); }
        if (said) announce(said);
        if (!quiet) { const to = focusSel && body.querySelector(focusSel); (to || heading).focus({ preventScroll: true }); } // the control that asked, or the list's heading: the keyboard is never left on the page behind (#9892)
    };
    const confirmView = (text, doIt, backTo, { destructive = false, origin = '', done = '' } = {}) => {
        body.replaceChildren();
        body.append(mk('p', 'team-link-confirm', text));
        const acts = mk('div', 'team-link-confirm-actions');
        const back = mk('button', 'btn team-link-back', 'Back'); back.type = 'button'; back.addEventListener('click', () => draw('', origin));
        escapeBack = () => draw('', origin); // Escape in a question is Back, not closing the dialog
        const go = mk('button', 'btn btn-primary team-link-go', backTo); go.type = 'button';
        go.addEventListener('click', async () => {
            go.disabled = back.disabled = true; dialog.dataset.busy = '1';
            const res = await doIt(); delete dialog.dataset.busy;
            if (res.ok) { await refresh(); draw('', '', done); } else draw(errorWords(res.status, res.code), origin);
        });
        acts.append(back, go); body.append(acts); (destructive ? back : go).focus(); // a revoke asks with Back focused: the safe answer, not the destructive button (#9892)
    };
    const refresh = async () => { const r = await call('GET', '/api/relay/links'); if (r.ok) { rows.length = 0; rows.push(...seen(r.data)); } };
    const confirmRevoke = (row) => {
        const who = row.end.label || row.end.team;
        const effect = row.mayMessageUs ? `${who} can no longer message this team` : `This team can no longer message ${who}`;
        confirmView(`Revoke this link with ${who} on ${nameOf(row.end.server)}? ${effect}, at once. What was already received stays.`, () => call('DELETE', `/api/relay/links/${encodeURIComponent(row.id)}`), 'Revoke', { destructive: true, origin: `.team-link-revoke[data-link-id="${String(row.id).replace(/"/g, '')}"]`, done: `Revoked the link with ${who} on ${nameOf(row.end.server)}.` });
    };
    const form = () => {
        const computers = pickableComputers(serverList, own.server, versionsKnown);
        const card = mk('section', 'team-link-card'); card.append(mk('h4', 'team-link-h', 'Link a team'));
        const f = mk('form', 'team-link-form'); f.noValidate = true;
        const cl = mk('label', null, 'Computer'); cl.htmlFor = 'team-link-computer';
        const computer = mk('select'); computer.id = 'team-link-computer';
        for (const c of computers) { const o = mk('option', null, c.label || 'A computer'); o.value = c.id; computer.append(o); }
        const tl = mk('label', null, 'Team'); tl.htmlFor = 'team-link-team';
        const team = mk('select'); team.id = 'team-link-team';
        const dl = mk('label', null, 'Who may message whom'); dl.htmlFor = 'team-link-direction';
        const dir = mk('select'); dir.id = 'team-link-direction';
        // both ways first: the operator's default (#9875, 06:27)
        for (const [v, w] of [['both', 'Both ways'], ['they', 'They may message this team'], ['we', 'This team may message them']]) { const o = mk('option', null, w); o.value = v; dir.append(o); }
        const go = mk('button', 'btn btn-primary team-link-link', 'Link'); go.type = 'submit'; go.disabled = true;
        const hint = mk('p', 'team-link-hint', computers.length ? '' : 'No other computer is online that can be linked.');
        const older = olderComputers(serverList, own.server, versionsKnown).map(s => mk('p', 'team-link-hint team-link-update', s.below_minimum === true ? `${s.label || 'A computer'} is below the Coral version Coral Hub allows${s.min_coral ? ` (${s.min_coral} or later)` : ''}. Update Coral there.` : `${s.label || 'A computer'} needs Coral ${LINK_MIN_VERSION} or later to be linked. Update Coral there.`));
        let teams = [];
        const loadTeams = async () => {
            team.replaceChildren(); go.disabled = true; hint.textContent = '';
            if (!computer.value) return;
            const r = await call('GET', `/api/remote/${encodeURIComponent(computer.value)}/api/board/projects`);
            teams = r.ok ? pickableTeams(r.data) : [];
            for (const t of teams) { const o = mk('option', null, t.label); o.value = t.id; team.append(o); }
            go.disabled = !teams.length;
            if (teams.length) bothHint();
            if (!teams.length) hint.textContent = r.ok ? 'That computer has no team that can be linked.' : 'Could not read that computer’s teams.';
        };
        computer.addEventListener('change', loadTeams);
        const bothHint = () => { hint.textContent = dir.value === 'both' && team.selectedOptions[0] ? `Links ${team.selectedOptions[0].textContent} and this team in both directions.` : ''; };
        dir.addEventListener('change', bothHint); team.addEventListener('change', bothHint);
        f.addEventListener('submit', (e) => {
            e.preventDefault();
            const c = computers.find(x => x.id === computer.value), t = teams.find(x => x.id === team.value);
            if (!c || !t) return;
            const other = { server: c.id, team: t.id };
            const words = { they: `${t.label} will be able to message ${teamName}`, we: `${teamName} will be able to message ${t.label}`, both: `${teamName} and ${t.label} will be able to message each other` }[dir.value];
            confirmView(`Link ${t.label} on ${c.label || 'that computer'}? ${words}, starting now.`, () => call('POST', '/api/relay/links', createBody(dir.value, own, other)), 'Link', { origin: '.team-link-link', done: `Linked ${t.label} on ${c.label || 'that computer'}.` });
        });
        f.append(cl, computer, tl, team, dl, dir, hint, ...older, go);
        card.append(f); body.append(card);
        loadTeams();
    };
    draw('', '', '', true);
}
