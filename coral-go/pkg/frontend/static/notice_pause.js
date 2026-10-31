/* Pause Coral's messages to one agent (#11388, the UI of Lead's per-agent notice pause): while the person talks to an agent, Coral holds what it would type into that agent's box (board notices, task
 * notifications), and says so. The chat header has ONE toggle (Pause Coral messages / Resume Coral messages, 44 px on a touch screen, aria-pressed); while paused a slim bar above the composer says
 * "Coral's messages are paused while you talk. 3 waiting. Resume." with the time left (a pause ends by itself after 30 minutes); while the server holds them only because the person is typing, a quiet hint says why: "Coral's messages wait while you type, and arrive when you stop".
 * The row's fields (the live row): notices_paused (bool), paused_until (RFC3339 or null: a pause that ends by itself), notices_holding (bool: the auto-hold while typing); the number waiting is the row's
 * notices_waiting, else its board_unread (waiting.js). The control is drawn only for a row that carries notices_paused as a boolean (the server's way of saying it has the pause). The two calls are in `api` below, the one place that knows the routes (a different shape from the server is a change here only). */
import { registerActions } from './actions.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { serverFetch, currentServer } from './server_base.js';
import { responseErrorText } from './server_status.js';
import { waitingCount } from './waiting.js';

const base = s => `/api/sessions/live/${encodeURIComponent(s.name)}/notices`;
/** The server's two routes (Lead's #11387): pause with `minutes` (the cap is 30 when it is 0 or left out, at most 720: ask for 30 so it is visible) and resume; both answer 200 with { notices_paused, paused_until, notices_waiting, notices_holding }. */
export const PAUSE_MINUTES = 30;
export const api = {
    pause: (s, minutes) => serverFetch(currentServer(), `${base(s)}/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: s.agent_type, session_id: s.session_id, minutes }) }),
    resume: s => serverFetch(currentServer(), `${base(s)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_type: s.agent_type, session_id: s.session_id }) }),
};

/** { paused, until (ms or 0), holding } of a live row. Strings and numbers only: payloads are untrusted. */
export function pauseOf(row) {
    const until = row && typeof row.paused_until === 'string' ? Date.parse(row.paused_until) : NaN;
    return { paused: !!(row && row.notices_paused === true), until: Number.isFinite(until) ? until : 0, holding: !!(row && row.notices_holding === true) };
}

/** "12 min left", "about a minute left", "ending now"; '' when the row has no end time (the server always sends one while paused: a pause ends by itself, at most 12 h). */
export function timeLeftText(until, now = Date.now()) {
    if (!until) return '';
    const mins = Math.round((until - now) / 60000);
    if (mins <= 0) return 'ending now';
    if (mins === 1) return 'about a minute left';
    return mins < 90 ? `${mins} min left` : `${Math.round(mins / 60)} h left`;
}

/** The bar's sentence for a row: '' when nothing is to be said. */
export function barText(row, now = Date.now()) {
    const p = pauseOf(row), n = Number.isSafeInteger(row && row.notices_waiting) && row.notices_waiting >= 0 ? Math.min(row.notices_waiting, 999) : waitingCount(row); // the server's own count of what the pause holds, else the unread board messages
    if (p.paused) { const left = timeLeftText(p.until, now); return `Coral's messages are paused while you talk. ${n} waiting.${left ? ` ${left}.` : ''}`; }
    if (p.holding) return "Coral's messages wait while you type, and arrive when you stop";
    return '';
}

let _timer = 0, _busy = false;

/** Paint the toggle and the bar from the open agent's row. Written only on a change. */
export function syncNoticePause(row) {
    const btn = document.getElementById('notice-pause-btn'), bar = document.getElementById('notice-pause-bar');
    const p = pauseOf(row), supported = !!row && typeof row.notices_paused === 'boolean', sleeping = !row || !!row.sleeping || !supported; // the server says it has the pause by sending the field: an older Coral (or one behind a hub) shows no dead control
    if (btn) {
        const label = p.paused ? 'Resume Coral messages' : 'Pause Coral messages';
        if (btn.hidden !== sleeping) btn.hidden = sleeping;
        if (btn.getAttribute('aria-pressed') !== String(p.paused)) btn.setAttribute('aria-pressed', String(p.paused));
        if (btn.getAttribute('aria-label') !== label) { btn.setAttribute('aria-label', label); btn.title = label; }
        btn.classList.toggle('notice-pause-on', p.paused);
        const icon = btn.querySelector('.material-icons'); const ic = p.paused ? 'pause_circle' : 'notifications';
        if (icon && icon.textContent !== ic) icon.textContent = ic;
    }
    if (bar) {
        const text = sleeping ? '' : barText(row), on = text !== '';
        const t = bar.querySelector('.notice-pause-text');
        if (t && t.textContent !== text) t.textContent = text;
        if (bar.classList.contains('notice-pause-idle') === on) bar.classList.toggle('notice-pause-idle', !on); // never hidden: a live region that is shown and filled in one turn is not announced (the way waiting.js keeps its line)
        bar.classList.toggle('notice-pause-hold', on && !p.paused);
        const resume = bar.querySelector('.notice-pause-resume'); if (resume && resume.hidden === p.paused) resume.hidden = !p.paused;
    }
    clearInterval(_timer); _timer = 0;
    if (p.paused && p.until) _timer = setInterval(() => { if (state.currentSession) syncNoticePause(state.currentSession); }, 30000); // the time left follows the clock // interval-ok: a 30 s repaint of one line from the row in memory, no request
}

async function toggle() {
    const s = state.currentSession;
    if (!s || _busy) return;
    _busy = true;
    const was = pauseOf(s).paused;
    try {
        const resp = await (was ? api.resume(s) : api.pause(s, PAUSE_MINUTES));
        if (!resp.ok) { showToast(await responseErrorText(resp, currentServer(), `${was ? 'Not resumed' : 'Not paused'} (HTTP ${resp.status}).`)); return; }
        let r = null; try { r = await resp.json(); } catch (e) { /* the row says it at the next tick */ }
        s.notices_paused = r && typeof r.notices_paused === 'boolean' ? r.notices_paused : !was; s.paused_until = r && typeof r.paused_until === 'string' ? r.paused_until : null; // the answer is the new state: the control does not wait for the next row
        if (r && Number.isSafeInteger(r.notices_waiting)) s.notices_waiting = r.notices_waiting;
        syncNoticePause(s);
    } catch (e) {
        showToast(`${was ? 'Not resumed' : 'Not paused'}: ${e && e.message ? e.message : 'the computer did not answer.'}`);
    } finally { _busy = false; }
}

registerActions({ 'notice-pause-toggle': () => toggle() });
