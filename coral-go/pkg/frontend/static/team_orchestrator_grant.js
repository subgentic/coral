// The team's Orchestrator access as fields of a settings_view (#11432): the Operator's switch that lets ONE session, the seat they pick, wake and sleep the agents on this team's board and launch onto it, within caps, with every
// action logged. The values are the keys of GET and PUT /api/board/{project}/orchestrator-grant; the log is GET /api/board/{project}/lifecycle-log. The server decides who may write (the verified Operator alone, the owner through
// Coral Hub); this page only draws what it is told and says what the server refused.
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js');
const { OG_KEYS, seatOfName, logLine } = await importOnce('./orchestrator_grant_words.js');
export { OG_KEYS };

const LIMITS = { perHour: [1, 100], live: [1, 50], idle: [1, 120] }; // the server's bounds (board.MaxOrchMaxPerHour, MaxOrchMaxLive, MaxOrchIdleMin)
/** Makes the group for one team. `team` is the team key; `members` resolves to the board's subscribers. */
export function createOrchestratorGrant(team, members) {
    let base = null; // what the server last had
    let log = [];
    let view = null;
    let logSlot = null;
    const seats = async () => {
        const subs = await members();
        const out = [{ value: '', label: 'No one' }];
        for (const m of subs) {
            const id = seatOfName(m.session_name);
            if (!id || /^terminal-/.test(m.session_name) || m.subscriber_id === 'Operator') continue;
            out.push({ value: id, label: m.job_title && m.job_title !== m.subscriber_id ? `${m.subscriber_id} (${m.job_title})` : m.subscriber_id });
        }
        return out;
    };
    const num = (key, label, unit, [lo, hi], help) => ({ key, type: 'number', label, unit, min: lo, max: hi, integer: true, compact: true, help, disabledWhen: v => !v.og_enabled });
    const drawLog = () => {
        if (!logSlot) return;
        logSlot.replaceChildren();
        if (!log.length) { const p = document.createElement('p'); p.className = 'sv-help'; p.textContent = 'Nothing yet.'; logSlot.append(p); return; }
        const ul = document.createElement('ul'); ul.className = 'orch-log';
        for (const e of log.slice(0, 20)) { const li = document.createElement('li'); li.textContent = `${new Date(e.at).toLocaleString()}: ${logLine(e)}`; ul.append(li); }
        logSlot.append(ul);
    };
    return {
        fields: () => [
            { key: 'og_enabled', type: 'toggle', label: 'Let the Orchestrator manage agents', help: 'Off by default. On: the seat below may wake and put to sleep this team\'s agents and start new ones here, within the limits. It cannot send them text, and everything it does is logged and said on the board.' },
            { key: 'og_seat', type: 'select', label: 'Orchestrator seat', help: 'The one agent that gets this. Only this session counts, whatever another agent calls itself.', disabledWhen: v => !v.og_enabled, options: seats, validate: (value, values) => (values.og_enabled && !value ? 'Pick the agent that gets this.' : '') },
            num('og_max_per_hour', 'Starts and wakes an hour', 'per hour', LIMITS.perHour, 'Across the whole team.'),
            num('og_max_live', 'Most agents running', 'agents', LIMITS.live, 'It cannot start or wake more once the team has this many running.'),
            num('og_idle_minutes', 'Put to sleep only if idle', 'minutes', LIMITS.idle, 'A working agent is left alone until it has been quiet this long. An agent waiting on you is never put to sleep.'),
            { key: 'og_log', type: 'custom', label: 'Recent actions', wide: true, render: slot => { logSlot = slot; drawLog(); return { get: () => undefined, set: () => {} }; } },
        ],
        /** Reads the grant and the log. Resolves to the values, or null when the server does not give them to this page (the group is then removed). */
        async load() {
            const r = await boardFetch(team, '/orchestrator-grant').catch(() => null);
            if (!r || !r.ok) return { refusal: r ? await refusalOf(r, answeredLocally(team)) : 'Unavailable', values: null };
            base = await r.json();
            const l = await boardFetch(team, '/lifecycle-log').catch(() => null);
            log = l && l.ok ? await l.json().catch(() => []) : [];
            drawLog();
            return { values: { og_enabled: !!base.enabled, og_seat: base.seat_session || '', og_max_per_hour: base.max_per_hour, og_max_live: base.max_live, og_idle_minutes: base.idle_minutes } };
        },
        bind(v) { view = v; },
        /** Saves the whole grant (the route takes it whole) and shows what the server kept. */
        async save(values) {
            const body = { enabled: !!values.og_enabled, seat_session: values.og_enabled ? values.og_seat : (values.og_seat || ''), max_per_hour: values.og_max_per_hour, max_live: values.og_max_live, idle_minutes: values.og_idle_minutes };
            const r = await boardFetch(team, '/orchestrator-grant', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw new Error(typeof j.error === 'string' && j.error ? j.error : await refusalOf(r, answeredLocally(team)));
            }
            base = await r.json();
            if (view) for (const [k, val] of Object.entries({ og_enabled: !!base.enabled, og_seat: base.seat_session || '', og_max_per_hour: base.max_per_hour, og_max_live: base.max_live, og_idle_minutes: base.idle_minutes })) view.set(k, val);
            const l = await boardFetch(team, '/lifecycle-log').catch(() => null);
            if (l && l.ok) { log = await l.json().catch(() => log); drawLog(); }
        },
    };
}
