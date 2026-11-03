/* Settings > Inbox (#12144, the Operator's design v6): what reaches Needs you. A switch for each kind of optional item, the teams the switches apply to, and the time of the daily items. Questions and decisions have no
 * switch and always reach the Operator. The values are the computer's own settings (inbox_kind_*, inbox_included_teams, inbox_digest_time): the page sends what it shows, and the server parses each value again. */
import { fetchProjectsChecked } from './board_fetch.js';
import { keyLabel } from './server_base.js';
import { settingBool } from './settings_core.js';
import { mutedReviewItems, mutedWords } from './inbox_reviews.js';
import { importOnce } from './import_once.js';

export const INBOX_KINDS = [
    { kind: 'file', key: 'inbox_kind_file', id: 'settings-inbox-file', label: 'Files for review', help: 'A file an agent wants you to read, approve or send back.' },
    { kind: 'done', key: 'inbox_kind_done', id: 'settings-inbox-done', label: 'Finished requests', help: '"Done. Does it work for you?" when a request of yours is finished, with what changed.' },
    { kind: 'release', key: 'inbox_kind_release', id: 'settings-inbox-release', label: 'Release summaries', help: 'One page per release: what is new for you and the known issues.' },
    { kind: 'decided', key: 'inbox_kind_decided', id: 'settings-inbox-decided', label: 'Decisions made for you', help: 'What the Orchestrator decided on your behalf, once a day.' },
    { kind: 'digest', key: 'inbox_kind_digest', id: 'settings-inbox-digest', label: 'Daily digest', help: 'What landed, what is blocked and what waits for you. Coral writes it from the board.' },
];

const teamsHost = () => document.getElementById('settings-inbox-teams');

/** The included teams as saved: "all" (or nothing saved) is every team; a list is those teams. */
export function includedTeams(raw) {
    const s = String(raw || '').trim();
    if (!s || s.toLowerCase() === 'all') return 'all';
    try { const list = JSON.parse(s); return Array.isArray(list) ? list.map(String) : 'all'; } catch { return 'all'; }
}

/** Draws the team boxes: every team of this computer, ticked when it is included. */
export async function drawInboxTeams(raw) {
    const host = teamsHost();
    if (!host) return;
    let projects = [];
    try { projects = (await fetchProjectsChecked()).map(p => p.project); // every contributing source is checked: a source that cannot be read is a failure, never an empty list
    } catch {
        // The teams could not be read: that is not an empty list. Say so, with a way to try again; no box is drawn, so Save sends the saved choice as it was (readIncludedTeams) and nothing is lost.
        const p = document.createElement('p'), b = document.createElement('button');
        p.className = 'sv-help settings-inbox-teams-failed'; p.setAttribute('role', 'alert');
        p.append('Your teams could not be loaded, so they cannot be changed now. What you saved stays as it is. ');
        b.type = 'button'; b.className = 'btn btn-quiet btn-small'; b.textContent = 'Retry';
        b.addEventListener('click', () => drawInboxTeams(raw));
        p.append(b);
        host.replaceChildren(p);
        return;
    }
    const chosen = includedTeams(raw);
    const frag = document.createDocumentFragment();
    if (!projects.length) { const p = document.createElement('p'); p.className = 'sv-help'; p.textContent = 'No teams yet. The switches apply to every team.'; frag.append(p); }
    for (const team of projects) {
        const label = document.createElement('label'), box = document.createElement('input');
        label.className = 'settings-inbox-team';
        box.type = 'checkbox'; box.checked = chosen === 'all' || chosen.includes(team); box.dataset.team = team;
        label.append(box, ` ${keyLabel(team)}`);
        frag.append(label);
    }
    host.replaceChildren(frag);
    delete host.dataset.everyTeam;
    host.addEventListener('change', e => { if (e.target && e.target.matches && e.target.matches('input[data-team]')) delete host.dataset.everyTeam; }); // a box changed by hand is a choice of its own: it is no longer "every team"
    if (chosen !== 'all' && projects.length) { // an explicit choice has a way back to "every team", for the teams that are not shown as well
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-quiet btn-small settings-inbox-every'; b.textContent = 'Include every team';
        b.addEventListener('click', () => { host.querySelectorAll('input[data-team]').forEach(x => { x.checked = true; }); host.dataset.everyTeam = '1'; b.remove(); });
        host.prepend(b);
    }
}

/** What the team boxes say. A saved explicit choice stays explicit: "all" is saved only when it was all, or when the person pressed Include every team; ticking every box that is DRAWN proves nothing about a team that is not (its computer is
 *  away, or it was left out), so it is never taken for "all". The ticked teams are saved, and a saved team that is not drawn now stays in the list as it was (Save never rewrites what it did not show). */
export function readIncludedTeams(fallback) {
    const host = teamsHost(), boxes = [...(host?.querySelectorAll('input[data-team]') || [])], saved = includedTeams(fallback);
    if (!boxes.length) return saved === 'all' ? 'all' : JSON.stringify(saved);
    if (host.dataset.everyTeam === '1') return 'all';
    if (saved === 'all') return boxes.every(b => b.checked) ? 'all' : JSON.stringify(boxes.filter(b => b.checked).map(b => b.dataset.team));
    const drawn = new Set(boxes.map(b => b.dataset.team)), ticked = boxes.filter(b => b.checked).map(b => b.dataset.team);
    const kept = saved.filter(t => !drawn.has(t));
    return JSON.stringify([...ticked, ...kept]);
}

/** Fills the Inbox controls from the saved settings: a kind is on unless it was turned off, the teams are all unless a list was saved, the time is 09:00 unless one was set. */
export function fillInboxSettings(s) {
    for (const k of INBOX_KINDS) {
        const box = document.getElementById(k.id);
        if (box) box.checked = settingBool(s[k.key] || undefined, true);
    }
    const t = document.getElementById('settings-inbox-digest-time');
    if (t) t.value = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.inbox_digest_time || '')) ? s.inbox_digest_time : '09:00';
    drawInboxTeams(s.inbox_included_teams);
    drawMutedLine();
}

/** The Inbox values as the page would save them: what the controls show, or the saved settings when the pane was never drawn. */
export function readInboxSettings(saved) {
    const out = {};
    for (const k of INBOX_KINDS) out[k.key] = document.getElementById(k.id)?.checked ?? settingBool(saved?.[k.key] || undefined, true);
    const t = document.getElementById('settings-inbox-digest-time');
    out.inbox_digest_time = t ? t.value.trim() || '09:00' : (saved?.inbox_digest_time || '09:00');
    out.inbox_included_teams = readIncludedTeams(saved?.inbox_included_teams);
    return out;
}

/** "Muted in the last 7 days: 4 release summaries, 2 finished requests." in the pane, from the files the server marked muted; hidden when none. */
export function drawMutedLine() {
    const el = document.getElementById('settings-inbox-muted');
    if (!el) return;
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    const words = mutedWords(mutedReviewItems().filter(a => Date.parse(a.created_at) >= week));
    el.hidden = !words;
    if (!words) { el.replaceChildren(); return; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-quiet btn-small'; b.textContent = 'Show them';
    b.addEventListener('click', () => { if (window.hideSettingsModal) window.hideSettingsModal(); if (window.switchNavTab) window.switchNavTab('hub-inbox'); importOnce('./inbox_tab.js').then(m => m.selectInboxTab('artifacts')).catch(() => {}); }); // the folder they are in
    el.replaceChildren(`Muted in the last 7 days: ${words}. `, b);
}
