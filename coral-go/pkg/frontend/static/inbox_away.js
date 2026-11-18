/* "While you were away" (#17537): one quiet line at the top of Needs you when the person comes back after five minutes or more without touching the page: how many tasks and goals were finished
 * meanwhile and how many agents are idle. Counts only. Nothing of it is in the start code: this lazy module watches the person's input from the first time Needs you is drawn; after a gap of five
 * minutes the input before the gap is when they went away. It asks the server once for what happened since then (GET /api/away, this computer's, the person's alone), says it, and keeps it until Dismiss or the next gap.
 * Switched off in Settings > Inbox (inbox_away). It is no item of Needs you and changes no count. Built with textContent only. */
import { state } from './state.js';
import { serverFetch, isCloud, LOCAL_SERVER, personalInboxSources, personalInboxAllowed } from './server_base.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
import { settingBool } from './settings_core.js';
import { importOnce } from './import_once.js';
import { presentationSessionState } from './session_state.js';

let banner = null, observer = null;
let result = null, asking = 0, dismissed = 0, lastInput = 0, away = 0, newest = null; // result: { from, text }; newest: the last slot to ask for the line

const idleAgents = () => (state.liveSessions || []).filter(s => s && s.session_id && s.agent_type !== 'terminal' && !s.sleeping && !s.archived && !s.not_started && s.starting === false && s.working === false && presentationSessionState(s) === 'idle').length;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const span = ms => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };

/** The words of the line for the counts, "" when nothing happened. */
export function awayText(away, idle, ms) {
    const parts = [];
    if (away.tasks_done > 0) parts.push(`${plural(away.tasks_done, 'task', 'tasks')} done`);
    if (away.goals_done > 0) parts.push(`${plural(away.goals_done, 'goal', 'goals')} done`);
    if (idle > 0) parts.push(`${plural(idle, 'agent', 'agents')} idle`);
    return parts.length ? `While you were away (${span(ms)}): ${parts.join(', ')}.` : '';
}

function draw(slot) {
    if (!result || !result.text || result.from !== away || result.from === dismissed || !settingBool(state.settings?.inbox_away, true)) { slot.replaceChildren(); return; }
    const box = el('div', 'inbox-away'); box.setAttribute('role', 'status');
    const close = el('button', 'btn btn-small inbox-away-dismiss', 'Dismiss'); close.type = 'button'; close.setAttribute('aria-label', 'Dismiss the while you were away line');
    close.addEventListener('click', () => { dismissed = result.from; for (const n of document.querySelectorAll('.inbox-away')) n.remove(); });
    box.append(el('span', 'inbox-away-text', result.text), close);
    slot.replaceChildren(box);
}

/** Fills `slot` with the line, or leaves it empty. Safe to call at every redraw: the answer is asked for once per gap. */
function fill(slot) {
    if (!slot) return;
    newest = slot;
    if (!lastInput) {
        lastInput = Date.now();
        for (const t of ['pointerdown', 'click', 'keydown', 'touchstart']) document.addEventListener(t, () => { const n = Date.now(), gap = n - lastInput > 3e5; if (gap) away = lastInput; lastInput = n; if (gap && newest && newest.isConnected) fill(newest); }, true); // the person's return is an input: the gap is known only then
    }
    const from = away;
    if (!(from > 0) || from === dismissed || !settingBool(state.settings?.inbox_away, true)) { slot.replaceChildren(); return; }
    if (result && result.from === from) { if (!slot.firstChild) draw(slot); return; }
    slot.replaceChildren();
    if (asking === from) return;
    asking = from;
    loadStyles('inbox_away.css').catch(() => {});
    // On this computer's own dashboard the one server is "local". Through the Hub the page's own origin is the Hub, which has no /api/away: the question goes to each computer the person owns that is online
    // (as the rest of Needs you does, personalInboxAllowed) and the counts are added (#19645).
    const servers = isCloud() ? personalInboxSources().map(x => x.id).filter(id => personalInboxAllowed(id)) : [LOCAL_SERVER];
    const since = encodeURIComponent(new Date(from).toISOString());
    Promise.all(servers.map(sv => serverFetch(sv, `/api/away?since=${since}`).then(r => (r.ok ? r.json() : null)).catch(() => null))).then(all => {
        const got = all.filter(a => a && typeof a.tasks_done === 'number');
        if (!got.length) { asking = 0; return; }
        const a = { tasks_done: got.reduce((n, x) => n + x.tasks_done, 0), goals_done: got.reduce((n, x) => n + (Number(x.goals_done) || 0), 0) };
        result = { from, text: awayText(a, idleAgents(), Date.now() - from) };
        if (newest && newest.isConnected) draw(newest);
    }).catch(() => { asking = 0; });
}

/** The Needs you list's banner: the line, then the signed-out notice when Claude is signed out (that notice's module is loaded from here so the start code holds one import for both). */
export function mountAway(slot, signedOut) {
    // The table supplies a fresh banner on redraw. Retire its previous mount,
    // including the observer and sign-in notice, instead of leaving old rows.
    observer?.disconnect();
    if (banner && banner !== slot) banner.remove();
    banner = slot; slot.replaceChildren();
    const aw = el('div'), sg = el('div'); slot.append(aw, sg);
    // An empty banner is no row of the list: it was a 24 px gap above the table (the rows moved when the list drew again) when neither the line nor the sign-in notice is there.
    const sync = () => { slot.hidden = !(aw.firstChild || sg.firstChild); }; sync();
    observer = new MutationObserver(sync); observer.observe(slot, { childList: true, subtree: true });
    if (signedOut) importOnce('./inbox_signin_notice.js').then(m => m.mountInboxSigninNotice(sg)).catch(() => {});
    fill(aw);
}
