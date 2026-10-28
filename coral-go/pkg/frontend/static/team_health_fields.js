// The team's Health check as fields of a settings_view (#7744): the values of the "health" object of GET and PUT /api/board/{project}/settings as flat keys, the fields that draw them, and the save
// that keeps the PUT's shape (the whole object, read again first so a rule another client changed while the page was open keeps that change, #4423). The server's limits are HEALTH_LIMITS.
import { importOnce } from './import_once.js';
import { boardFetch } from './server_base.js';
import { rebaseChanges } from './settings_diff.js';
const { HEALTH_DEFAULTS, HEALTH_LIMITS } = await importOnce('./team_health_settings.js');
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js'); // lazy modules load the others they need through importOnce, so a failed load is retried

const [LO, HI] = HEALTH_LIMITS.minutes;
const [N_LO, N_HI] = HEALTH_LIMITS.nudges;
const [G_LO, G_HI] = HEALTH_LIMITS.goalTasks;
const [L_LO, L_HI] = HEALTH_LIMITS.landingWait;
const [R_LO, R_HI] = HEALTH_LIMITS.releaseWait;
/** The server's rule for a tag pattern (ReleaseTagPatternValid): letters, digits, . _ - / and the glob characters * ? [ ] ^, at most 60, not starting with -; empty is the default. */
export const tagPatternProblem = (value) => {
    const p = String(value || '').trim();
    if (!p) return '';
    return p.length > 60 || p[0] === '-' || !/^[A-Za-z0-9._/*?[\]^-]+$/.test(p) ? `"${p.slice(0, 40)}" is not a tag pattern Coral reads (letters, digits, . _ - / and the glob characters * ? [ ]; at most 60 characters).` : '';
};
const [C_LO, C_HI] = HEALTH_LIMITS.checkWait;
/** The server's words for a branch name it will not read (LandingBranchValid): letters, digits and . _ - /, at most 100, not starting with - or /, no .., not ending in / or .lock; empty is the default. */
export const branchProblem = (value) => {
    const b = String(value || '').trim();
    if (!b) return '';
    const bad = b.length > 100 || b[0] === '-' || b[0] === '/' || b.includes('..') || b.endsWith('/') || b.endsWith('.lock') || !/^[A-Za-z0-9._/-]+$/.test(b);
    return bad ? `"${b.slice(0, 40)}" is not a branch name Coral reads (letters, digits, . _ - /; at most 100 characters).` : '';
};
const RULES = ['claim_nudge', 'status_nudge', 'mention_renudge', 'held_notice', 'busy_no_task', 'post_no_task', 'upload_no_task', 'goal_size', 'ask_reminder', 'landing', 'release', 'goals_ready', 'unowned_tasks'];

/** The health object as the flat values of the fields. */
export function healthToValues(h) {
    const v = { on: !!h.on, interval_min: h.interval_min, recipient: h.recipient || '', all_clear: !!h.all_clear, default_reviewers: (h.default_reviewers || []).join(', '), auto_delegate_on: !!(h.auto_delegate && h.auto_delegate.on) };
    for (const k of RULES) if (h[k]) for (const [p, val] of Object.entries(h[k])) v[`${k}_${p}`] = val;
    return v;
}

/** The values as a health object: what the fields show over what was read (so a field the page does not know goes back as it was). */
export function valuesToHealth(v, base) {
    const h = JSON.parse(JSON.stringify(base));
    h.on = !!v.on;
    h.interval_min = Number.isInteger(v.interval_min) ? v.interval_min : base.interval_min; // a number that is not a whole number keeps what was read
    h.recipient = v.recipient || '';
    h.all_clear = !!v.all_clear;
    h.default_reviewers = String(v.default_reviewers || '').split(',').map(s => s.trim()).filter((s, i, a) => s && a.indexOf(s) === i);
    h.auto_delegate = { ...h.auto_delegate, on: !!v.auto_delegate_on };
    h.claim_nudge = { ...h.claim_nudge, on: !!v.claim_nudge_on, after_min: v.claim_nudge_after_min, nudges: v.claim_nudge_nudges };
    h.status_nudge = { ...h.status_nudge, on: !!v.status_nudge_on, after_min: v.status_nudge_after_min, escalate_after_min: v.status_nudge_escalate_after_min };
    h.mention_renudge = { ...h.mention_renudge, on: !!v.mention_renudge_on, after_min: v.mention_renudge_after_min };
    if (h.ask_reminder && v.ask_reminder_on !== undefined) h.ask_reminder = { ...h.ask_reminder, on: !!v.ask_reminder_on, after_min: v.ask_reminder_after_min };
    if (h.held_notice && v.held_notice_on !== undefined) h.held_notice = { ...h.held_notice, on: !!v.held_notice_on, after_min: v.held_notice_after_min };
    if (h.busy_no_task && v.busy_no_task_on !== undefined) h.busy_no_task = { ...h.busy_no_task, on: !!v.busy_no_task_on, after_min: v.busy_no_task_after_min };
    if (h.post_no_task && v.post_no_task_on !== undefined) h.post_no_task = { ...h.post_no_task, on: !!v.post_no_task_on };
    if (h.upload_no_task && v.upload_no_task_on !== undefined) h.upload_no_task = { ...h.upload_no_task, on: !!v.upload_no_task_on };
    if (h.release && v.release_on !== undefined) h.release = { ...h.release, on: !!v.release_on, branch: String(v.release_branch || '').trim(), tag_pattern: String(v.release_tag_pattern || '').trim(), wait_min: Number.isInteger(v.release_wait_min) ? v.release_wait_min : h.release.wait_min, nudge: v.release_nudge || '' };
    if (h.landing && v.landing_on !== undefined) h.landing = { ...h.landing, on: !!v.landing_on, branch: String(v.landing_branch || '').trim(), wait_min: Number.isInteger(v.landing_wait_min) ? v.landing_wait_min : h.landing.wait_min, nudge: v.landing_nudge || '' };
    for (const k of ['goals_ready', 'unowned_tasks']) if (h[k] && v[`${k}_on`] !== undefined) h[k] = { ...h[k], on: !!v[`${k}_on`], wait_min: Number.isInteger(v[`${k}_wait_min`]) ? v[`${k}_wait_min`] : h[k].wait_min, nudge: v[`${k}_nudge`] || '' };
    if (h.goal_size && v.goal_size_on !== undefined) h.goal_size = { ...h.goal_size, on: !!v.goal_size_on, limit: v.goal_size_limit };
    return h;
}

/** The keys of the values (the page sends a change of any of them as the health object). */
export const HEALTH_KEYS = Object.keys(healthToValues({ ...HEALTH_DEFAULTS, held_notice: HEALTH_DEFAULTS.held_notice }));

/** The fields of the Health check group. ctx: { members: () => Promise<[{ subscriber_id, job_title }]>, hasHeld: () => bool, monitorOff: () => bool, onReset(view), openSettings() }. */
export function healthFields(ctx) {
    const alsoTell = (rule) => ({ type: 'select', label: 'Also tell', help: 'One member who also gets it as a message of their own when it is new.', disabledWhen: v => !v[`${rule}_on`], options: async () => {
        const members = await ctx.members();
        return [{ value: '', label: 'Only the orchestrator' }, ...members.map(m => ({ value: m.subscriber_id, label: `${m.subscriber_id}${m.job_title ? ` (${m.job_title})` : ''}` }))];
    } });
    const minutes = (key, label, unit, ruleOn) => ({ key, type: 'number', label, unit, min: LO, max: HI, integer: true, compact: true, disabledWhen: v => !v[ruleOn] });
    const fields = [
        { key: 'health_global_off', type: 'notice', visibleWhen: () => ctx.monitorOff(), render: slot => {
            const note = document.createElement('p'); note.className = 'sv-help health-global-off'; note.setAttribute('role', 'status');
            note.append('Team health checks are turned off for all of Coral, so this team\'s check will not run. Turn on "Team health checks" in ');
            const link = document.createElement('button'); link.type = 'button'; link.className = 'sv-learn working-mode-settings-link'; link.textContent = 'Settings';
            link.addEventListener('click', () => ctx.openSettings());
            note.append(link, '. It takes effect after Coral restarts.'); slot.append(note);
        } },
        { key: 'on', type: 'toggle', label: 'Send health check', help: 'Checks on stuck or idle agents. Uses tokens each time. A new team starts with it on.' },
        { key: 'interval_min', type: 'number', label: 'Check every', unit: 'minutes', min: LO, max: HI, integer: true, compact: true, disabledWhen: v => !v.on },
        { key: 'recipient', type: 'select', label: 'Send it to', disabledWhen: v => !v.on, options: async () => {
            const members = await ctx.members();
            return [{ value: '', label: 'The orchestrator (default)' }, ...members.map(m => ({ value: m.subscriber_id, label: `${m.subscriber_id}${m.job_title ? ` (${m.job_title})` : ''}` }))];
        } },
        { key: 'all_clear', type: 'toggle', label: 'Post when all is well', help: 'So a quiet team is not mistaken for a stopped check.', disabledWhen: v => !v.on },
        { key: 'health_reviews', type: 'heading', label: 'Reviews' },
        { key: 'auto_delegate_on', type: 'toggle', label: 'Hand reviews to the default reviewers', help: 'When a task is submitted for review and nobody is assigned, Coral delegates it to the default reviewers; with none named, reviews wait for the orchestrator. Works whether or not the health check is on.' },
        { key: 'default_reviewers', type: 'text', label: 'Default reviewers', wide: true, help: `Names of agents on this team, up to ${HEALTH_LIMITS.reviewers}, separated by commas.`, placeholder: `Agent names (up to ${HEALTH_LIMITS.reviewers})`,
            validate: v => (new Set(String(v).split(',').map(s => s.trim()).filter(Boolean)).size > HEALTH_LIMITS.reviewers ? `at most ${HEALTH_LIMITS.reviewers} names.` : '') },
        { key: 'health_rules', type: 'heading', label: 'Automatic rules', help: 'Run only while the health check is on.' },
        { key: 'claim_nudge_on', type: 'toggle', label: 'Nudge an idle agent to claim its work', help: 'An agent that is idle with ready work gets a reminder; past the count, the orchestrator is told.' },
        minutes('claim_nudge_after_min', 'After', 'minutes idle', 'claim_nudge_on'),
        { key: 'claim_nudge_nudges', type: 'number', label: 'Nudges before telling the orchestrator', unit: 'nudges', min: N_LO, max: N_HI, integer: true, compact: true, disabledWhen: v => !v.claim_nudge_on },
        { key: 'status_nudge_on', type: 'toggle', label: 'Ask a quiet agent for a status', help: 'An agent that has done nothing for a while is asked where it stands; if it stays quiet, the orchestrator is told.' },
        minutes('status_nudge_after_min', 'Ask after', 'minutes quiet', 'status_nudge_on'),
        minutes('status_nudge_escalate_after_min', 'Tell the orchestrator', 'minutes later', 'status_nudge_on'),
        { key: 'held_notice_on', type: 'toggle', label: 'Tell the Operator about a held delivery', visibleWhen: () => ctx.hasHeld(),
            help: 'A message Coral could not type into an agent (its terminal is on a dialog) and has held back for a while is reported to the Operator.' },
        { ...minutes('held_notice_after_min', 'After', 'minutes held', 'held_notice_on'), visibleWhen: () => ctx.hasHeld() },
        { key: 'mention_renudge_on', type: 'toggle', label: 'Remind the orchestrator of an unanswered mention', help: 'A message that @mentions the orchestrator and has had no reply gets a reminder.' },
        minutes('mention_renudge_after_min', 'Remind the orchestrator after', 'minutes', 'mention_renudge_on'),
        { key: 'health_offbooks', type: 'heading', label: 'Work done off the books', help: 'Named to the orchestrator in the next health check, once each.' },
        { key: 'busy_no_task_on', type: 'toggle', label: 'Tell the orchestrator about an agent working with no task', help: 'An agent that has been working for a while with no task in progress is named in the next health check, once.' },
        minutes('busy_no_task_after_min', 'Working with no task for', 'minutes', 'busy_no_task_on'), // a short unit: a longer one runs past the edge of a phone at 200% text
        { key: 'post_no_task_on', type: 'toggle', label: 'Tell the orchestrator about a commit posted with no task', help: 'A commit, SHA or patch posted on the board with no task number, by an agent with no task in progress, is named in the next health check, once.' },
        { key: 'upload_no_task_on', type: 'toggle', label: 'Tell the orchestrator about an artifact uploaded with no task', help: 'An artifact uploaded by an agent with no task in progress (and not marked as having no task) is named in the next health check, once.' },
        { key: 'goal_size_on', type: 'toggle', label: 'Tell the orchestrator when a goal has too many tasks', help: 'A goal that is not closed and has more tasks than the limit (open and done together) is named in the next health check, and again at each further limit.' },
        { key: 'goal_size_limit', type: 'number', label: 'More than', unit: 'tasks in a goal', min: G_LO, max: G_HI, integer: true, compact: true, disabledWhen: v => !v.goal_size_on },
        { key: 'health_landing', type: 'heading', label: 'Landing', help: 'Finished work that has not landed. Reads the local branch only, never CI or GitHub.' },
        { key: 'landing_on', type: 'toggle', label: 'Landing alert', help: 'When tasks were finished since the branch last moved and it has stood still for the wait, the next health check says so, again after each further wait.' },
        { key: 'landing_branch', type: 'text', label: 'Branch', placeholder: 'main', help: 'The branch finished work lands on.', disabledWhen: v => !v.landing_on, validate: branchProblem },
        { key: 'landing_wait_min', type: 'number', label: 'Wait', unit: 'minutes', help: '15 minutes to 7 days', min: L_LO, max: L_HI, integer: true, compact: true, disabledWhen: v => !v.landing_on },
        { key: 'landing_nudge', ...alsoTell('landing') },
        { key: 'health_ready', type: 'heading', label: 'Goals and open tasks', help: 'Two more lines of the check, on unless a team turns them off.' },
        { key: 'goals_ready_on', type: 'toggle', label: 'Goals ready to close', help: 'A goal whose tasks are all done or cancelled, with at least one done, for the wait is named in the next health check, once.' },
        { key: 'goals_ready_wait_min', type: 'number', label: 'Wait', unit: 'minutes', help: '5 minutes to 7 days', min: C_LO, max: C_HI, integer: true, compact: true, disabledWhen: v => !v.goals_ready_on },
        { key: 'goals_ready_nudge', ...alsoTell('goals_ready') },
        { key: 'unowned_tasks_on', type: 'toggle', label: 'Open tasks with no goal or no assignee', help: 'Open tasks that have had no goal or no assignee for the wait are named by number in the next health check, once for each set.' },
        { key: 'unowned_tasks_wait_min', type: 'number', label: 'Wait', unit: 'minutes', help: '5 minutes to 7 days', min: C_LO, max: C_HI, integer: true, compact: true, disabledWhen: v => !v.unowned_tasks_on },
        { key: 'unowned_tasks_nudge', ...alsoTell('unowned_tasks') },
        { key: 'health_release', type: 'heading', label: 'Release', help: 'A branch that is past its newest release tag. Reads the local tags only, never CI or GitHub.' },
        { key: 'release_on', type: 'toggle', label: 'Release alert', help: 'When the branch has commits after the newest release tag for the wait, the next health check says so, again after each further wait.' },
        { key: 'release_branch', type: 'text', label: 'Branch', placeholder: 'main', help: 'The branch releases are cut from.', disabledWhen: v => !v.release_on, validate: branchProblem },
        { key: 'release_tag_pattern', type: 'text', label: 'Tag pattern', placeholder: 'v*', help: 'v* also matches prereleases, such as v2.0.1-beta.', disabledWhen: v => !v.release_on, validate: tagPatternProblem },
        { key: 'release_wait_min', type: 'number', label: 'Wait', unit: 'minutes', help: '1 hour to 30 days', min: R_LO, max: R_HI, integer: true, compact: true, disabledWhen: v => !v.release_on },
        { key: 'release_nudge', type: 'select', label: 'Also tell', help: 'One member who also gets it as a message of their own when it is new.', disabledWhen: v => !v.release_on, options: async () => {
            const members = await ctx.members();
            return [{ value: '', label: 'Only the orchestrator' }, ...members.map(m => ({ value: m.subscriber_id, label: `${m.subscriber_id}${m.job_title ? ` (${m.job_title})` : ''}` }))];
        } },
        { key: 'health_questions', type: 'heading', label: 'Questions', help: 'Works whether or not the health check is on.' },
        { key: 'ask_reminder_on', type: 'toggle', label: 'Remind about unanswered questions', help: 'When an agent asks a question and the member it asks has not answered, remind that member once.' },
        minutes('ask_reminder_after_min', 'Remind the member after', 'minutes', 'ask_reminder_on'),
        { key: 'health_defaults', type: 'custom', label: 'Defaults', help: 'Put every health setting back to the defaults. Save to apply them.', action: { label: 'Reset to defaults', run: view => ctx.onReset(view) } },
    ];
    // The alert rules repeat the words Branch, Wait and Also tell under their own headings: each rule is a group named by its legend (a fieldset), so a screen reader's forms list says which rule a "Wait" belongs to; the screen looks the same (#9173)
    const RULE = { landing_on: 'Landing', release_on: 'Release', goals_ready_on: 'Goals ready to close', unowned_tasks_on: 'Open tasks with no goal or assignee' };
    return fields.map(f => RULE[f.key] ? { ...f, fieldset: RULE[f.key] } : f);
}

/** The server's own words for a refused setting start with the API path ("health.unowned_tasks.nudge: ..."): the field's label stands there instead ("Also tell: ..."), and a path no field has is left out, so no API name reaches the screen (#9016). */
export function plainRefusal(words) {
    const hit = /^(?:health\.)?([a-z]+(?:_[a-z]+)*(?:\.[a-z_]+)?):\s+([\s\S]+)$/.exec(String(words || ''));
    if (!hit) return words;
    const field = healthFields({}).find(f => f.key === hit[1].replace('.', '_') && f.label && f.type !== 'heading');
    return field ? `${field.label}: ${hit[2]}` : hit[2];
}

/** Saves the health values: the whole object, read again first, with only what the person changed (resolves to the object the server kept; throws the reason in words). */
export async function saveHealth(team, base, values) {
    const now = await boardFetch(team, '/settings');
    const fresh = now.ok ? (await now.json()).health : null;
    if (!fresh || typeof fresh !== 'object') throw new Error(`Could not read the current health check to save it. ${now.ok ? 'Try again.' : await refusalOf(now, answeredLocally(team))}`);
    const health = rebaseChanges(base, valuesToHealth(values, base), fresh);
    const resp = await boardFetch(team, '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', health }) });
    if (!resp.ok) {
        const local = answeredLocally(team), words = plainRefusal(await refusalOf(resp.clone(), local));
        // this computer's own refusal of a landing field ("landing.nudge: ... is not a member of this team") is shown at that field as well as in the bar (#8967; the same for goals_ready and unowned_tasks, #9006)
        const body = local ? await resp.json().catch(() => null) : null, hit = body && typeof body.error === 'string' ? /^(?:health\.)?(landing|release|goals_ready|unowned_tasks)\.(branch|tag_pattern|wait_min|nudge):\s*(.+)$/.exec(body.error) : null;
        throw Object.assign(new Error(`Could not save the health check. ${words}`), hit ? { fields: { [`${hit[1]}_${hit[2]}`]: hit[3].slice(0, 200) } } : {}); // the refusal in our words, never the server's (#5323)
    }
    const saved = (await resp.json()).health;
    return saved && typeof saved === 'object' ? saved : health;
}
