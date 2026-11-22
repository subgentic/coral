import { loadStyles } from './lazy_styles.js';
/* Presentation only: the server owns detection and delivery gates. Never infer a limit from chat words. */
const VENDORS = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
export function usageLimit(s, now = Date.now()) {
    const b = s?.blocked;
    if (s?.sleeping || s?.waiting_for_input || s?.stuck || s?.not_started || b?.kind !== 'usage_limit') return null;
    const at = typeof b.reset_at === 'string' ? Date.parse(b.reset_at) : NaN;
    if (Number.isFinite(at) && at <= now) return null;
    return { vendor: VENDORS[b.vendor] || 'Agent', at: Number.isFinite(at) ? at : null };
}
export function resetClock(at, now = Date.now()) {
    if (!at) return 'time unknown';
    const d = new Date(at), today = new Date(now), tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (d.toDateString() === today.toDateString()) return clock;
    if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${clock}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}
function resetWords(at, now = Date.now()) {
    const clock = resetClock(at, now);
    return clock.startsWith('tomorrow ') ? `tomorrow at ${clock.slice(9)}` : `at ${clock}`;
}
export function usageLimitDetail(s, now = Date.now()) {
    const limit = usageLimit(s, now);
    if (!limit) return '';
    if (!limit.at) return 'Reset time unknown: this CLI does not say.';
    const minutes = Math.max(1, Math.ceil((limit.at - now) / 60000));
    const left = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
    return `Resets ${resetWords(limit.at, now)} · in ${left}`;
}
function usageLimitGroups(sessions, now) {
    const groups = new Map();
    for (const s of sessions) { const l = usageLimit(s, now); if (!l) continue; const key = `${l.vendor}:${l.at ? Math.floor(l.at / 60000) : null}`; const g = groups.get(key) || { ...l, count: 0 }; g.count++; groups.set(key, g); }
    return [...groups.values()];
}
export function usageLimitSummaries(sessions, now = Date.now()) {
    return usageLimitGroups(sessions, now).map(g => `${g.count} ${g.vendor} agent${g.count === 1 ? '' : 's'} ${g.at ? `${g.count === 1 ? 'waits' : 'wait'} for the reset ${resetWords(g.at, now)}` : `${g.count === 1 ? 'is' : 'are'} limited, reset time unknown`}`);
}
export function usageLimitChat(s, notice) {
    if (!notice && !usageLimit(s)) return '';
    if (s?.sleeping && s.sleep_reason === 'agent_exited') return `${notice} Its CLI exited; this agent is asleep and will not be resumed automatically.`;
    const l = usageLimit(s);
    if (!l) return notice || '';
    const when = l.at ? `it resets ${resetWords(l.at)} (${usageLimitDetail(s).split(' · ')[1]}).` : 'its limit resets. This CLI doesn’t say when.';
    const resume = s.limit_resume_at ? `Coral will try to resume it ${resetWords(Date.parse(s.limit_resume_at))}.` : 'No automatic resume is scheduled.';
    return `Usage limit. This agent can’t work until ${when}${l.at ? " Coral won’t send it anything until then." : ""} ${resume}`;
}
let refreshTimer;
/** The boundary can pass while the live feed is quiet; one timer refreshes the presentation. */
export function scheduleUsageLimitRefresh(sessions, refresh) {
    clearTimeout(refreshTimer);
    const times = sessions.map(s => usageLimit(s)?.at).filter(Boolean);
    if (times.length) refreshTimer = setTimeout(refresh, Math.min(2147483647, Math.max(1, Math.min(...times) - Date.now() + 1)));
}
/** Markup stays lazy too; row rendering and escaping are the list's existing helpers. */
export function usageLimitList(sessions, renderRow, esc) {
    const limited = sessions.filter(s => usageLimit(s));
    if (limited.length) loadStyles('usage_limit.css');
    const summary = usageLimitGroups(limited, Date.now()).map(g => {
        const name = `<strong>${esc(`${g.count} ${g.vendor} agent${g.count === 1 ? '' : 's'}`)}</strong>`;
        const clock = resetClock(g.at).replace(/^tomorrow (.+)$/, '$1 tomorrow');
        const time = `<strong>${esc(clock)}</strong>`;
        const desktop = g.at ? `${name} ${g.count === 1 ? 'waits' : 'wait'} for the reset at ${time}` : `${name} ${g.count === 1 ? 'is' : 'are'} limited, reset time unknown`;
        const phone = g.at ? `${name} ${g.count === 1 ? 'resets' : 'reset'} ${time}` : `${name}: reset time unknown`;
        return `<p class="usage-limit-desktop">${desktop}</p><p class="usage-limit-phone">${phone}</p>`;
    }).join('');
    return {
        regular: sessions.filter(s => !usageLimit(s) && (!limited.length || !s.sleeping)),
        sleeping: limited.length ? sessions.filter(s => s.sleeping) : [],
        summary: limited.length ? `<li class="usage-limit-summary" aria-label="${esc(usageLimitSummaries(limited).join('. '))}"><span class="usage-limit-mark" aria-hidden="true">!</span><div>${summary}<small>Coral sends nothing to them until then. Other agents carry on.</small></div></li>` : '',
        waiting: limited.length ? `<li class="usage-limit-heading" role="heading" aria-level="2"><span class="usage-limit-desktop">Waiting for a usage limit to reset · ${limited.length}</span><span class="usage-limit-phone">Usage limit · ${limited.length}</span></li>` + limited.map(s => renderRow(s, '__usage_limit__', true, false, '')).join('') : '',
    };
}
export function usageLimitPresentation(s, key, derive, opts) {
    if (s?.blocked?.kind !== 'usage_limit' || s.sleeping || ['stuck', 'needs_input', 'check_terminal'].includes(key)) return key;
    return usageLimit(s) ? 'usage_limit' : derive({ ...s, blocked: null }, opts);
}
export function usageLimitState(s, esc) {
    const label = `Usage limit · ${resetClock(usageLimit(s)?.at)}`;
    const limit = usageLimit(s);
    const short = limit?.at ? `Limit · resets ${resetClock(limit.at)}` : 'Limit · reset time unknown';
    return { label, short, pill: label, dot: 'usage-limit', pillClass: 'usage-limit', chip: 'idle', attention: false, vendorTag: usageLimitVendorTag(s, esc) };
}

export async function paintUsageLimitNotice(container, session, data, state, serverOf, paint) {
    const row = state.liveSessions.find(s => s.session_id === session.session_id && serverOf(s) === serverOf(session)) || session;
    if (data.limit_notice || row.blocked?.kind === 'usage_limit') await loadStyles('usage_limit.css');
    if (container.isConnected && state.currentSession?.session_id === session.session_id && serverOf(state.currentSession) === serverOf(session)) {
        paint(container, usageLimitChat(row, data.limit_notice || ''));
        const note = container.querySelector('.chat-usage-limit-notice');
        if (note && (row.blocked?.kind === 'usage_limit' || (row.sleeping && row.sleep_reason === 'agent_exited'))) note.className = 'chat-usage-limit-notice notice notice-warn';
    }
}
function usageLimitVendorTag(s, esc) {
    const limit = usageLimit(s);
    return limit ? `<span class="usage-limit-vendor">${esc(limit.vendor)}</span>` : '';
}
