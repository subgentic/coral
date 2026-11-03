/* Settings > Inbox (#12144, the Operator's design v6): what reaches Needs you. A switch for each kind of optional item, the teams the switches apply to, and the time of the daily items. Questions and decisions have no
 * switch and always reach the Operator. The values are the computer's own settings (inbox_kind_*, inbox_included_teams, inbox_digest_time): the page sends what it shows, and the server parses each value again. */
import { fetchProjects } from './board_fetch.js';
import { keyLabel } from './server_base.js';
import { settingBool } from './settings_core.js';
import { mutedReviewItems, mutedWords } from './inbox_reviews.js';

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
    try { projects = (await fetchProjects()).map(p => p.project); } catch { /* none to draw: the list says so */ }
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
}

/** What the team boxes say: "all" when every box is ticked (or there are none to tick), else the JSON list of the ticked teams. */
export function readIncludedTeams(fallback) {
    const boxes = [...(teamsHost()?.querySelectorAll('input[data-team]') || [])];
    if (!boxes.length) return fallback === undefined ? 'all' : includedTeams(fallback) === 'all' ? 'all' : JSON.stringify(includedTeams(fallback));
    if (boxes.every(b => b.checked)) return 'all';
    return JSON.stringify(boxes.filter(b => b.checked).map(b => b.dataset.team));
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
    el.textContent = words ? `Muted in the last 7 days: ${words}. They are in the Artifacts folder.` : '';
}
