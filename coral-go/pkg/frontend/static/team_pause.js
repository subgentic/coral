/* The team's pause, as the person sees it (#15331, walk 22): the header says Paused, one line under it says since when and what happens (agents get new messages when you resume) with a Resume button,
 * and the Actions menu item is Pause team / Resume team and says what it did in a toast. It stands on its own: it does not wait for the Board tab to have been opened (its code loads with the Board tab, so a first click
 * from any other tab found nothing to run and did nothing). The truth is the server's: GET /paused answers { paused, since, by_sleep }; POST /pause and /resume change it. A pause that sleep put there is
 * Asleep, not Paused: nothing here draws for it. Loaded on demand (importOnce); zero start bytes. */
import { state } from './state.js';
import { boardFetch } from './server_base.js';
import { showToast } from './utils.js';
import { bs } from './board_state.js';
import { importOnce, loadedModule } from './import_once.js';
import { loadStyles } from './lazy_styles.js';
await loadStyles('team_pause.css');

let queuedSince = '';
/** The mark on a message posted since the pause began (the Board's rows ask for it through loadedModule). */
export const queuedBadge = m => (queuedSince && !m.is_system && m.created_at >= queuedSince ? '<span class="mb-queued">Queued: delivered on resume</span>' : '');

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clock = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

/** What the page knows of the team's pause: { team, paused, since, bySleep } (the team page reads state.teamPause for its header). */
function remember(team, data, say = false) {
    state.teamPause = { team, paused: !!data.paused && !data.by_sleep, since: typeof data.since === 'string' ? data.since : '', bySleep: !!data.by_sleep };
    bs.isPaused = !!data.paused;
    window.__coral?._setBoardChatPaused?.(!!data.paused, say); // the Board dock's menu and banner
    queuedSince = state.teamPause.paused ? state.teamPause.since : ''; // messages since the pause are marked Queued
    syncButton();
    drawBar();
    try { loadedModule('./board_window.js')?.renderMessages?.(bs._allMessages); } catch { /* the Board is not on screen */ } // the Board's rows again, with or without the mark
    document.dispatchEvent(new CustomEvent('coral:team-pause-changed', { detail: { team, paused: state.teamPause.paused } }));
}

/** The Actions menu item's words (the same button the Board column owns, adopted into the team page's menu). A team asleep keeps its own word, Wake Team. */
function syncButton() {
    const b = document.getElementById('mb-pause-btn'), p = state.teamPause; if (!b || !p) return;
    if (!p.bySleep) b.textContent = p.paused ? 'Resume team' : 'Pause team';
    const note = document.getElementById('mb-pause-note');
    if (note && !p.bySleep) note.textContent = p.paused ? 'Agents get messages again when you resume.' : 'Agents stop receiving new messages until you resume.';
    b.classList.toggle('mb-action-danger', !!p.paused && !p.bySleep);
}

/** The line under the header while the team is paused, with the way out. */
function drawBar() {
    const p = state.teamPause, head = document.getElementById('team-page-head'); if (!head) return;
    let bar = document.getElementById('team-pause-bar');
    if (!p || !p.paused || p.team !== state.boardPageProject) { if (bar) bar.hidden = true; return; }
    if (!bar) {
        bar = el('div', 'team-pause-bar'); bar.id = 'team-pause-bar'; bar.setAttribute('role', 'status');
        const text = el('span', 'team-pause-text'); const btn = el('button', 'btn btn-small team-pause-resume', 'Resume team'); btn.type = 'button';
        btn.addEventListener('click', () => toggleTeamPause());
        bar.append(text, btn); head.after(bar);
    }
    const at = p.since ? clock(p.since) : '';
    bar.firstChild.textContent = `${at ? `Paused since ${at}` : 'Paused'}: agents get new messages when you resume.`;
    bar.hidden = false;
}

/** Reads the pause from the server and draws it. The team page calls it when it opens and on its counts' poll. */
export async function readTeamPause(team = state.boardPageProject, say = false) {
    if (!team) return null;
    try {
        const r = await boardFetch(team, '/paused');
        if (!r.ok) return null;
        const data = await r.json();
        if (team !== state.boardPageProject) return null; // another team came up while it was read
        remember(team, data, say);
        return state.teamPause;
    } catch { return null; }
}

/** Pause or resume the team on screen, and say it. A team asleep is woken instead (its pause is sleep's own). */
export async function toggleTeamPause(team = state.boardPageProject) {
    if (!team) return;
    await readTeamPause(team); // read first, every time: a click acts on the server's pause, not on a copy gone stale (and a first click is never lost for want of one)
    const p = state.teamPause;
    if (p && p.bySleep) { (await importOnce('./team_actions.js')).toggleTeamSleep(team, 'wake'); return; }
    const resume = !!(p && p.paused);
    try {
        const r = await boardFetch(team, resume ? '/resume' : '/pause', { method: 'POST' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { showToast(`Could not ${resume ? 'resume' : 'pause'} the team${data && data.error ? `: ${data.error}` : ''}.`, true); return; }
        await readTeamPause(team, true); // the pause time comes from the server; the live region says what changed
        showToast(resume ? 'Team resumed: agents get messages again.' : 'Team paused: agents get new messages when you resume.', false, 4000);
    } catch { showToast(`Could not ${resume ? 'resume' : 'pause'} the team (the connection failed).`, true); }
}
