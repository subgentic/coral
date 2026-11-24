// The team's review size guard as fields of a settings_view (#21027, brief task 3 of goal #302): off by default; when a review's diff is over the lines or the files set here the review shows a warning
// banner (nothing is blocked). The values are GET and PUT /api/board/{project}/review-size ({on, lines, files, skip, only_roles, roles}); PUT takes the whole setting and answers it back, so a role's own numbers
// ('roles', set elsewhere) are sent back as they were read. The server decides who may write (Orchestrator or Operator, this computer only); this page draws what it is told and says what the server refused.
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js');
export const RS_KEYS = ['rs_on', 'rs_lines', 'rs_files', 'rs_skip', 'rs_scope', 'rs_roles', 'rs_over'];

const toValues = s => ({ rs_on: !!s.on, rs_lines: Number(s.lines) > 0 ? Number(s.lines) : '', rs_files: Number(s.files) > 0 ? Number(s.files) : '', rs_skip: (s.skip || []).join(', '), rs_scope: (s.only_roles || []).length ? 'roles' : 'team', rs_roles: s.only_roles || [], rs_over: ['send_back', 'split'].includes(s.over_limit) ? s.over_limit : 'warn' });
const NO_LIMIT = 'Set a limit for lines or files, or turn the warning off.';
/** An empty box is no limit; a number must be a whole number from 0 to `max`. */
const whole = (v, max) => (v === null || v === undefined || v === '' || (Number.isInteger(v) && v >= 0 && v <= max) ? '' : `use a whole number from 0 to ${max.toLocaleString('en-US')}.`);
const skipList = text => String(text || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);

/** Makes the group for one team. `members` resolves to the board's subscribers (the roles offered). */
export function createReviewSize(team, members) {
    let base = null; // what the server last had
    let view = null;
    const roles = async () => {
        const out = new Map();
        for (const m of await members().catch(() => [])) {
            if (m.subscriber_id === 'Operator' || /^terminal-/.test(m.session_name || '')) continue;
            const name = m.job_title && m.job_title !== m.subscriber_id ? m.job_title : m.subscriber_id;
            out.set(name, { value: name, label: name });
        }
        for (const r of (base && base.only_roles) || []) if (!out.has(r)) out.set(r, { value: r, label: r }); // a role set before keeps showing
        return [...out.values()];
    };
    return {
        fields: () => [
            { key: 'rs_on', type: 'toggle', label: 'Warn when a change is too big to review', help: 'Off by default. Warns only: nothing is blocked or sent back.' },
            { key: 'rs_lines', type: 'number', label: 'Lines changed over', min: 0, max: 1000000, compact: true, disabledWhen: v => !v.rs_on, attrs: { inputmode: 'numeric' },
                validate: (value, v) => whole(value, 1000000) || (v.rs_on && !(Number(v.rs_lines) > 0) && !(Number(v.rs_files) > 0) ? NO_LIMIT : '') },
            { key: 'rs_files', type: 'number', label: 'Files changed over', min: 0, max: 100000, compact: true, disabledWhen: v => !v.rs_on, attrs: { inputmode: 'numeric' },
                help: 'Either limit warns. Leave one empty to use only the other.', validate: value => whole(value, 100000) },
            { key: 'rs_skip', type: 'text', label: 'Skip these paths (not counted)', wide: true, placeholder: '*.lock, **/generated/**', disabledWhen: v => !v.rs_on, help: 'Separate paths with commas; * ? and ** work.' },
            { key: 'rs_over', type: 'select', label: 'Over the limit', disabledWhen: v => !v.rs_on, options: [{ value: 'warn', label: 'Warn: show a banner' }, { value: 'send_back', label: 'Send back: ask the author to split' }, { value: 'split', label: 'Split: the Orchestrator files follow-ups' }],
                help: 'Warn is the default. Send back and Split add a button to the banner; nothing happens until someone presses it.' },
            { key: 'rs_scope', type: 'select', label: 'Applies to', disabledWhen: v => !v.rs_on, options: [{ value: 'team', label: 'Whole team' }, { value: 'roles', label: 'Only these roles' }] },
            { key: 'rs_roles', type: 'multiselect', label: 'Roles', options: roles, visibleWhen: v => v.rs_scope === 'roles', disabledWhen: v => !v.rs_on,
                help: 'Saved per team. A role can have its own numbers under Roles.',
                validate: (value, v) => (v.rs_scope === 'roles' && !(value || []).length ? 'Choose at least one role, or choose the whole team.' : '') },
        ],
        /** Reads the setting. Resolves to the values, or null when the server does not give them to this page (the group is then removed). */
        async load() {
            const r = await boardFetch(team, '/review-size').catch(() => null);
            if (!r || !r.ok) return { refusal: r ? await refusalOf(r, answeredLocally(team)) : 'Unavailable', values: null };
            base = await r.json();
            return { values: toValues(base) };
        },
        bind(v) {
            view = v;
            // The no-limit sentence sits on Lines but depends on Files and on the switch, which the view does not re-check when they change: clear it when the setting is fine again.
            const recheck = () => { const e = v.host.querySelector('.sv-row[data-key=rs_lines] .sv-error'); if (!e || !e.textContent.includes(NO_LIMIT)) return; const x = v.values(); if (!x.rs_on || Number(x.rs_lines) > 0 || Number(x.rs_files) > 0) v.error('rs_lines', ''); };
            v.host.addEventListener('input', recheck); v.host.addEventListener('change', recheck);
        },
        /** Saves the whole setting and shows what the server kept. */
        async save(values) {
            const body = { ...(base || {}), on: !!values.rs_on, lines: Math.max(0, Math.round(Number(values.rs_lines) || 0)), files: Math.max(0, Math.round(Number(values.rs_files) || 0)), skip: skipList(values.rs_skip), only_roles: values.rs_scope === 'roles' ? [...(values.rs_roles || [])] : [], over_limit: values.rs_over || 'warn' };
            const r = await boardFetch(team, '/review-size', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw new Error(typeof j.error === 'string' && j.error ? j.error : await refusalOf(r, answeredLocally(team)));
            }
            base = await r.json();
            if (view) for (const [k, val] of Object.entries(toValues(base))) view.set(k, val);
        },
    };
}
