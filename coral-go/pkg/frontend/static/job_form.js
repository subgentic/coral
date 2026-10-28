/* The New job / Edit job dialog (#7908): a settings_view in form mode. The fields are drawn from the spec below (label above, Required, the first invalid field focused, a status line under the
 * form); what is the job's own stays here: the schedule picker with its sentence, the workflow list, the time limit in words, the request. The ids of the controls are the page's contract and stay. */
import { state } from './state.js';
import { mountSettingsView } from './settings_view.js';
import { ensureBuilt } from './lazy_dom.js';
import { escapeHtml, showToast } from './utils.js';
import { changedFields, NOTHING_TO_SAVE } from './settings_diff.js';
import { cronWords, atWords, localZone, zoneNote, RUNS_WHILE_OPEN } from './job_words.js';
import { importOnce } from './import_once.js';
import { joinBrowse } from './dir_row.js';
const { DAYS, MINUTE_STEPS, HOUR_STEPS, composeCron, parseCron } = await importOnce('./cron_picker.js'); // this form loads on first use (#10218), and so do the pieces only it uses
const { limitSeconds, limitParts } = await importOnce('./time_limit.js');

let view = null;
let editingJobId = null;  // non-null when editing an existing job
let openedJob = null;     // what the editor showed for the job it opened (#4423): Save sends only what the person changed since
let noOwnWorkflows = false; // none of the workflows is the person's own: the list is empty or holds only the seeded example (its description starts with Example, #9965)
let repoOffer = '';      // the server refused the folder for a missing repository or first commit (#10276): the form offers to make it one
let noWorkflows = false;  // the workflow list came back empty: the form says so and offers to make one

const DEFAULT_CRON = '0 9 * * *'; // a new job runs every day at 09:00 until the person says otherwise (#10276): the time a first job is most often wanted, not every hour
const LOCAL_ZONE = localZone(); // a schedule is read in the person's own zone unless they pick another (Automations #4)
// The ways to say when: the first four are pickers, Advanced is the cron box. `compose` turns a picker's state into the cron expression the server takes; `parse` reads one back (null: only the cron box can say it).
const MODES = [['minutes', 'Every N minutes'], ['hours', 'Every N hours'], ['daily', 'Daily at'], ['weekly', 'Weekly on'], ['cron', 'Advanced']];

// A choice button's on state: the look (active) and what a screen reader hears (aria-pressed), set together (#6348).
const press = (b, on) => { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(!!on)); };

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

/** The Repository path shows its end while it is not being edited: a path's last part is the folder's name (#7121). */
function showPathEnd() {
    const i = document.getElementById('job-modal-repo');
    if (i && document.activeElement !== i) i.scrollLeft = i.scrollWidth;
}
document.addEventListener('focusout', e => { if (e.target && e.target.id === 'job-modal-repo') showPathEnd(); });

/** Whether the browser knows this name as a time zone (the server falls back to UTC for one it does not know, so a typo would run the job at the wrong hour). */
function zoneKnown(tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
const zoneMessage = tz => (zoneKnown(tz || LOCAL_ZONE) ? '' : `"${tz}" is not a time zone name. Use one like UTC or Europe/Berlin.`);

/** aria-invalid is "true" or absent: an empty attribute reads as false to a screen reader. */
function markInvalid(e, bad) { if (bad) e.setAttribute('aria-invalid', 'true'); else e.removeAttribute('aria-invalid'); }

// -- the schedule picker: four pickers and an Advanced cron box, one sentence for what it means ------------

const pickerState = { mode: 'daily', n: 1, at: '09:00', days: new Set([1]) };

/** Shows the picker the mode names (its panel, its pressed button) and writes the cron expression the picker says into the box the form reads. */
function setMode(mode, { focus = false, keepCron = false } = {}) {
    pickerState.mode = mode;
    document.querySelectorAll('#sched-picker .sched-preset').forEach(b => press(b, b.dataset.mode === mode));
    for (const p of document.querySelectorAll('#sched-picker [data-for]')) p.hidden = !p.dataset.for.split(' ').includes(mode);
    const unit = document.getElementById('sched-every-unit'); if (unit) unit.textContent = mode === 'minutes' ? 'minutes' : 'hours';
    const every = document.getElementById('job-modal-every');
    if (every && (mode === 'minutes' || mode === 'hours')) { // only the steps that divide the hour or the day: "every 7 hours" would not be every 7 hours
        const steps = mode === 'minutes' ? MINUTE_STEPS : HOUR_STEPS;
        const keep = steps.includes(pickerState.n) ? pickerState.n : steps.reduce((b, s) => (Math.abs(s - pickerState.n) < Math.abs(b - pickerState.n) ? s : b), steps[0]);
        every.replaceChildren(...steps.map(s => { const o = document.createElement('option'); o.value = String(s); o.textContent = String(s); return o; }));
        every.value = String(keep); pickerState.n = keep;
    }
    const cronInput = document.getElementById('job-modal-cron');
    if (mode !== 'cron' && !keepCron) cronInput.value = composeCron(pickerState);
    if (mode === 'cron' && focus) cronInput.focus();
    checkSchedule();
    view && view.refresh();
}
/** A picker's control changed: its state is the cron box's new value. */
function pickerChanged() {
    const st = pickerState;
    st.n = Number(document.getElementById('job-modal-every').value) || 1;
    st.at = document.getElementById('job-modal-at').value || '09:00';
    st.days = new Set([...document.querySelectorAll('#sched-picker .sched-day')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => +b.dataset.day));
    document.getElementById('job-modal-cron').value = composeCron(st);
    checkSchedule();
    view && view.refresh();
}
/** The cron expression in the picker: a shape a picker can say shows in it, anything else is Advanced with its box shown. */
function showCron(expr) {
    const st = parseCron(expr);
    document.getElementById('job-modal-cron').value = expr;
    if (st) {
        Object.assign(pickerState, { n: 1, at: '09:00', days: new Set([1]) }, st);
        document.getElementById('job-modal-at').value = pickerState.at;
        document.querySelectorAll('#sched-picker .sched-day').forEach(b => b.setAttribute('aria-pressed', String(pickerState.days.has(+b.dataset.day))));
    }
    setMode(st ? st.mode : 'cron', { keepCron: true });
}

/** "Runs every day at 02:00. Next: tomorrow 02:00." The schedule as the Jobs page says it; a zone other than the person's own is named: "Runs every day at 02:00 (Asia/Tokyo). Next: today 18:00, your time." */
export function previewWords(expr, tz, nextIso) {
    const words = cronWords(expr);
    const runs = words.startsWith('Schedule:') ? `Runs on the schedule ${expr}` : 'Runs ' + words.charAt(0).toLowerCase() + words.slice(1);
    const other = zoneNote(tz);
    const next = nextIso ? ` Next: ${atWords(nextIso)}${other ? ', your time' : ''}.` : '';
    return `${runs}${other}.${next}`;
}

let checkSeq = 0;
async function checkSchedule() {
    const my = ++checkSeq;
    const expr = document.getElementById('job-modal-cron').value.trim();
    const tz = document.getElementById('job-modal-timezone').value.trim() || LOCAL_ZONE;
    const preview = document.getElementById('cron-preview');
    const zoneOk = zoneKnown(tz);
    if (view) view.error('timezone', zoneOk ? '' : zoneMessage(tz));
    if (!expr) { preview.textContent = ''; return; }
    try {
        const resp = await fetch('/api/scheduled/validate-cron', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cron_expr: expr, timezone: zoneOk ? tz : 'UTC' }),
        });
        const data = await resp.json();
        if (my !== checkSeq) return; // a newer check is on its way
        markInvalid(document.getElementById('job-modal-cron'), !data.valid);
        if (data.valid) {
            preview.textContent = previewWords(expr, tz, (data.next_fire_times || [])[0]);
            preview.classList.remove('sched-preview-bad');
        } else {
            preview.textContent = 'That is not a schedule Coral can read. Check the five fields.';
            preview.classList.add('sched-preview-bad');
        }
    } catch (e) {
        if (my !== checkSeq) return;
        preview.textContent = 'Could not check the schedule just now.';
        preview.classList.add('sched-preview-bad');
    }
}

function scheduleField() {
    return {
        key: 'cron_expr', type: 'custom', id: 'sched-picker', labelId: 'sched-label', label: 'When', required: true, requiredMessage: 'Enter a schedule, or pick one above.', default: DEFAULT_CRON,
        render: slot => {
            slot.setAttribute('role', 'group'); slot.setAttribute('aria-labelledby', 'sched-label');
            const modes = el('div', 'sched-presets');
            for (const [mode, label] of MODES) {
                const b = el('button', 'sched-preset', label); b.type = 'button'; b.dataset.mode = mode; press(b, mode === pickerState.mode);
                b.addEventListener('click', () => setMode(mode, { focus: true }));
                modes.append(b);
            }
            // the pickers: a number (every N minutes or hours), a time, and the days of the week; each says its part of the sentence and writes the cron expression behind it
            const every = el('div', 'sched-line'); every.dataset.for = 'minutes hours';
            const everyLab = el('label', 'sched-line-label', 'Every'); const n = el('select', 'field field-dense sched-n'); n.id = 'job-modal-every'; n.setAttribute('aria-label', 'Every, how many');
            n.addEventListener('change', pickerChanged);
            const unit = el('span', 'sched-unit', 'hours'); unit.id = 'sched-every-unit';
            every.append(everyLab, n, unit);
            const days = el('div', 'sched-days'); days.dataset.for = 'weekly'; days.setAttribute('role', 'group'); days.setAttribute('aria-label', 'Days of the week');
            for (const [num, name] of DAYS) {
                const d = el('button', 'btn btn-small sched-day', name); d.type = 'button'; d.dataset.day = String(num); d.setAttribute('aria-pressed', String(pickerState.days.has(num)));
                d.addEventListener('click', () => { d.setAttribute('aria-pressed', String(d.getAttribute('aria-pressed') !== 'true')); pickerChanged(); });
                days.append(d);
            }
            const at = el('div', 'sched-line'); at.dataset.for = 'daily weekly';
            const atLab = el('label', 'sched-line-label', 'At'); const time = el('input', 'field field-dense sched-time'); time.type = 'time'; time.id = 'job-modal-at'; time.value = pickerState.at;
            time.addEventListener('input', pickerChanged);
            at.append(atLab, time);
            const row = el('div', 'sched-custom-row'); row.id = 'sched-custom-row'; row.dataset.for = 'cron'; row.hidden = true;
            const lab = el('label', 'sched-cron-field', 'Cron expression');
            const input = el('input', 'field sched-cron-input'); input.type = 'text'; input.id = 'job-modal-cron'; input.placeholder = '0 2 * * *'; input.value = DEFAULT_CRON; input.setAttribute('aria-describedby', 'sched-cron-help cron-preview');
            input.addEventListener('input', () => checkSchedule());
            lab.append(input);
            const help = el('div', 'job-help'); help.id = 'sched-cron-help';
            const code = el('code', '', '0 2 * * *');
            help.append('Five fields: minute, hour, day of month, month, day of week. ', code, ' is every day at 02:00.');
            row.append(lab, help);
            const preview = el('div', 'sched-preview'); preview.id = 'cron-preview'; preview.setAttribute('role', 'status');
            const whenNote = el('p', 'sched-when-note', `Runs ${RUNS_WHILE_OPEN}`);
            slot.append(modes, every, days, at, row, preview, whenNote);
            for (const p of slot.querySelectorAll('[data-for]')) p.hidden = !p.dataset.for.split(' ').includes(pickerState.mode);
            return {
                get: () => input.value.trim(),
                set: v => showCron(v || ''),
                invalid: on => { if (on || !document.getElementById('cron-preview').classList.contains('sched-preview-bad')) markInvalid(input, on); }, // the cron box itself carries the mark a screen reader reads
                focus: () => { if (pickerState.mode === 'weekly' && !composeCron(pickerState)) { slot.querySelector('.sched-day')?.focus(); return; } if (!input.value.trim() && pickerState.mode !== 'cron') setMode('cron'); (input.closest('[hidden]') ? slot.querySelector('.sched-preset.active') : input)?.focus(); }, // the field a person must fill: the first day of a weekly schedule with none, else the cron box (shown for an empty one)
            };
        },
    };
}

// -- the time limit: a number and a unit, read as seconds ---------------------------------------------

function limitField() {
    return {
        key: 'max_duration_s', type: 'custom', id: 'job-modal-limit', labelId: 'job-modal-limit-label', label: 'Time limit', default: 3600,
        validate: v => (v && v.error) || '',
        render: slot => {
            const wrap = el('span', 'sched-limit-fields');
            const n = el('input'); n.type = 'number'; n.id = 'job-modal-timeout'; n.value = '1'; n.min = '1'; n.step = '1'; n.setAttribute('inputmode', 'numeric'); n.setAttribute('aria-label', 'Time limit');
            const unit = el('select'); unit.id = 'job-modal-timeout-unit'; unit.setAttribute('aria-label', 'Time limit unit');
            for (const [value, label] of [['3600', 'hours'], ['60', 'minutes'], ['1', 'seconds']]) { const o = el('option', '', label); o.value = value; unit.append(o); }
            unit.value = '3600';
            wrap.append(n, unit); slot.append(wrap);
            const live = () => { const r = limitSeconds(n.value, unit.value); markInvalid(n, !!r.error); if (view) view.error('max_duration_s', r.error || ''); }; // the sentence is said as it is typed, not only when Create is pressed
            n.addEventListener('input', live); unit.addEventListener('change', live);
            return {
                get: () => limitSeconds(n.value, unit.value),
                set: seconds => { const p = limitParts(seconds || 3600); n.value = String(p.n); unit.value = String(p.unit); },
            };
        },
    };
}

// -- the fields ---------------------------------------------------------------------------------------

function jobFields(host) {
    const prompt = v => v.job_type === 'prompt', workflow = v => v.job_type === 'workflow';
    return [
        {
            key: 'job_type', type: 'custom', id: 'job-type-toggle', label: 'Type', default: 'workflow',
            render: slot => {
                slot.classList.add('job-type-toggle', 'btn-seg');
                let value = 'workflow';
                const buttons = [['prompt', 'smart_toy', 'Run a prompt'], ['workflow', 'account_tree', 'Run a workflow']].map(([type, icon, label]) => {
                    const b = el('button', 'btn job-type-btn'); b.type = 'button'; b.dataset.type = type;
                    const ic = el('span', 'material-icons', icon); ic.setAttribute('aria-hidden', 'true'); ic.style.fontSize = 'var(--fs-xl)';
                    b.append(ic, ` ${label}`);
                    b.addEventListener('click', () => { api.set(type); slot.dispatchEvent(new Event('change', { bubbles: true })); requestAnimationFrame(showPathEnd); }); // the path field has a width once its tab is shown
                    return b;
                });
                const api = {
                    get: () => value,
                    set: t => { value = t === 'prompt' ? 'prompt' : 'workflow'; for (const b of buttons) press(b, b.dataset.type === value); },
                };
                slot.append(...buttons); api.set('workflow');
                return api;
            },
        },
        { key: 'name', type: 'text', id: 'job-modal-name', label: 'Name', required: true, requiredMessage: 'Give the job a name.', placeholder: 'e.g. nightly-tests' },
        scheduleField(), // When is the heart of a job: right after its name, in view when the dialog opens, not under the prompt where a short window cut it (#9965)
        { key: 'workflow_id', type: 'select', id: 'job-modal-workflow', label: 'Workflow', required: true, requiredMessage: 'Pick the workflow this job runs.', options: [{ value: '', label: 'Select a workflow\u2026' }], visibleWhen: workflow },
        {
            key: 'no_workflows', type: 'notice', visibleWhen: v => workflow(v) && noWorkflows,
            render: slot => {
                slot.id = 'job-modal-no-workflows'; slot.classList.add('job-no-workflows');
                const b = el('button', 'btn btn-small', 'Create one'); b.type = 'button'; b.setAttribute('data-on-click', 'job-create-workflow');
                slot.append(el('span', '', 'No workflows yet.'), ' ', b);
            },
        },
        { key: 'repo_path', type: 'path', id: 'job-modal-repo', label: 'Folder', required: true, requiredMessage: 'Choose a folder: type a path, or use Browse.', messageAsIs: true, placeholder: 'Choose a folder', help: 'The folder the agent works in: a git folder with at least one commit.', default: '', attrs: { 'data-coral-root': host.dataset.coralRoot || '' }, visibleWhen: prompt,
            live: [{ id: 'btn-browse-job', wide: true, describes: false }, { id: 'dir-browser-job', wide: true, describes: false }] }, // Browse and its folder list, as New agent has them (#10276)
        {
            key: 'repo_offer', type: 'notice', visibleWhen: v => prompt(v) && !!repoOffer,
            render: slot => {
                slot.id = 'job-repo-offer'; slot.classList.add('job-no-workflows');
                const b = el('button', 'btn btn-small', 'Make this folder a git repo'); b.type = 'button'; b.id = 'job-make-repo'; b.addEventListener('click', makeRepo);
                const n = el('button', 'btn btn-small', 'Run without a worktree'); n.type = 'button'; n.id = 'job-run-here'; n.addEventListener('click', runHere);
                slot.append(el('span', '', 'A job works in its own worktree of this folder, which needs a git repository with one commit.'), ' ', b, ' ', n);
            },
        },
        {
            key: 'agent_type', type: 'select', id: 'job-modal-agent', label: 'Agent', default: 'claude', visibleWhen: prompt,
            options: [{ value: 'claude', label: 'Claude' }, { value: 'agy', label: 'Antigravity (agy)' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'Pi' }],
            setup: e => e.setAttribute('data-on-change', 'flag-agent-change'),
        },
        { key: 'prompt', type: 'textarea', id: 'job-modal-prompt', label: 'Prompt', required: true, requiredMessage: 'Write the prompt the agent runs.', rows: 4, placeholder: 'Run the full test suite and report failures...', visibleWhen: prompt },
        { key: 'extras', type: 'heading', fold: true, id: 'job-modal-more', label: 'More options' },
        { key: 'description', type: 'text', id: 'job-modal-description', label: 'Description', placeholder: 'e.g. Runs the full test suite' },
        {
            key: 'timezone', type: 'text', id: 'job-modal-timezone', label: 'Time zone', default: LOCAL_ZONE, placeholder: LOCAL_ZONE,
            validate: v => zoneMessage(String(v || '').trim() || LOCAL_ZONE),
            setup: e => { e.classList.add('field', 'sched-tz-input'); e.addEventListener('input', () => checkSchedule()); },
        },
        limitField(),
        { key: 'base_branch', type: 'text', id: 'job-modal-branch', label: 'Base branch', placeholder: "the repo's current branch", default: '', visibleWhen: prompt },
        { key: 'flags', type: 'text', id: 'job-modal-flags', label: 'Flags', placeholder: 'e.g. --verbose', default: '', visibleWhen: prompt },
        {
            key: 'flag_shortcuts', type: 'notice', visibleWhen: prompt,
            render: slot => {
                const box = el('div', 'flag-shortcuts');
                const b = el('button', 'btn btn-small flag-shortcut-btn', '--chrome'); b.type = 'button';
                b.setAttribute('data-on-click', 'flag-toggle'); b.setAttribute('data-flag-input', 'job-modal-flags'); b.setAttribute('data-flag', '--chrome');
                box.append(b); slot.append(box);
            },
        },
        { key: 'no_worktree', type: 'toggle', id: 'job-modal-no-worktree', label: 'Run in the folder itself, without a worktree', default: false, help: 'Each run works straight in the folder, which can be any folder, not a git repository. Runs that overlap share it.', visibleWhen: prompt },
        { key: 'cleanup_worktree', type: 'toggle', id: 'job-modal-cleanup', label: 'Remove the worktree when the run ends', default: true, visibleWhen: v => prompt(v) && !v.no_worktree },
    ];
}

// -- the form's values, as the job's fields -----------------------------------------------------------

/** jobFormValues is what the editor's fields hold, as the job's fields (those of the type it shows). */
function jobFormValues() {
    const v = view.values();
    const limit = v.max_duration_s;
    const values = {
        name: String(v.name || '').trim(),
        description: String(v.description || '').trim(),
        cron_expr: String(v.cron_expr || '').trim(),
        timezone: String(v.timezone || '').trim() || LOCAL_ZONE,
        max_duration_s: (limit && limit.seconds) || 3600,
        cleanup_worktree: v.cleanup_worktree ? 1 : 0,
        no_worktree: v.job_type !== 'workflow' && v.no_worktree ? 1 : 0,
        job_type: v.job_type,
    };
    if (v.job_type === 'workflow') {
        values.workflow_id = v.workflow_id ? parseInt(v.workflow_id) : null;
    } else {
        values.repo_path = String(v.repo_path || '').trim();
        values.base_branch = String(v.base_branch || '').trim(); // empty: the repo's current branch (the server's default), not a guessed "main"
        values.agent_type = v.agent_type;
        values.prompt = String(v.prompt || '').trim();
        values.flags = String(v.flags || '').trim();
    }
    return values;
}

/** Run in the folder itself (#10276): the worktree is switched off for this job, the refusal goes, and the person creates the job again. */
function runHere() {
    view.set('no_worktree', true); view.fold(true); // the switch is under More options: opened, so the person sees what was set
    repoOffer = ''; view.error('repo_path', ''); view.refresh();
    showToast('This job will work in the folder itself. Create it again.');
}

/** Make the folder a repository with one first commit, once the person has agreed (#10276); then the form is submitted again by the person, with nothing else changed. */
function makeRepo() {
    const dir = String(view.values().repo_path || '').trim();
    if (!dir) return;
    window.showConfirmModal('Make this folder a git repo', `Coral will run git init in ${dir} if it is not a repository yet, and make one empty first commit, so each run of the job has a branch to start from. Nothing in the folder is changed.`, async () => {
        try {
            const resp = await fetch('/api/scheduled/jobs/init-repo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_path: dir }) });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || data.error) { showToast(data.error || 'Could not make the folder a git repo.', true); return; }
            repoOffer = ''; view.error('repo_path', ''); view.refresh();
            showToast('The folder is a git repo with a first commit. Create the job again.');
        } catch { showToast('Could not make the folder a git repo.', true); }
    }, undefined, { label: 'Make it a git repo', danger: false });
}

async function submitJob() {
    const values = jobFormValues();
    const isEdit = editingJobId !== null;
    // An edit sends only what the person changed since the editor opened, so a field another client changed
    // meanwhile keeps that change (#4423); a new job sends everything.
    const body = isEdit && openedJob ? changedFields(openedJob, values) : values;
    if (isEdit && !Object.keys(body).length) {
        showToast(NOTHING_TO_SAVE);
        hideJobModal();
        return;
    }
    const resp = await fetch(isEdit ? `/api/scheduled/jobs/${editingJobId}` : '/api/scheduled/jobs', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.error && data.field === 'base_branch') { // a base branch the repo does not have: said under the field (an alert), the section opened, the field focused (#6707)
        view.error('base_branch', data.error);
        view.focus('base_branch');
        throw new Error(data.error);
    }
    const repoWhy = data.error && /^repo_path (?:is not (an existing directory|a git repository)|has no (commit yet)): (.*)$/s.exec(data.error);
    if (repoWhy) { // the server refused the repository path: said under that field, which takes the focus, in words (a refusal at the dialog's foot was far from the field, #9965)
        const why = repoWhy[1] || repoWhy[2], dir = repoWhy[3];
        view.error('repo_path', why === 'a git repository' ? `That folder is not a git repository: ${dir}` : why === 'commit yet' ? `That repository has no commit yet: ${dir}` : `That folder does not exist: ${dir}`);
        repoOffer = why === 'an existing directory' ? '' : why; // a folder that is not there cannot be made a repository; the other two can
        view.refresh();
        view.focus('repo_path');
        throw new Error('The folder above needs fixing first.'); // the dialog's foot says it in words; the server's own line names the field (repo_path) and is the field's, said above (#10558)
    }
    if (data.error) throw new Error(data.error);
    // no toast: the job's page says it, in words, under the title (scheduler.js, "Created. Next run today 06:00 your time."), where a toast would cover the title on a phone or the page's own actions (#9298)
    hideJobModal();
    document.dispatchEvent(new CustomEvent('job-saved', { detail: { id: data.id, saved: isEdit ? 'updated' : 'created' } })); // the Jobs page reads the list again and opens it
}

// -- the dialog ----------------------------------------------------------------------------------------

function jobView() {
    if (view) return view;
    ensureBuilt('job-modal'); // built on first open (#4500)
    const host = document.getElementById('job-form');
    const footer = document.getElementById('job-footer');
    footer.replaceChildren();
    view = mountSettingsView(host, {
        mode: 'form',
        fields: jobFields(host),
        form: { submit: 'Create job', submitId: 'job-modal-submit', cancel: 'Cancel', barHost: footer, onSubmit: submitJob, onCancel: hideJobModal },
    });
    joinBrowse('job-modal-repo', 'btn-browse-job'); // Browse at the input's right, as New agent has it (#10276)
    return view;
}

async function loadWorkflowOptions() {
    const select = document.getElementById('job-modal-workflow');
    if (!select) return;
    try {
        const resp = await fetch('/api/workflows');
        const data = await resp.json();
        const workflows = data.workflows || [];
        noWorkflows = workflows.length === 0;
        noOwnWorkflows = workflows.every(w => /^Example/.test(w.description || ''));
        select.innerHTML = `<option value="">${workflows.length ? 'Select a workflow\u2026' : 'No workflows yet'}</option>` +
            workflows.map(w => `<option value="${Number(w.id)}">${escapeHtml(w.name)}${w.description ? ' \u2014 ' + escapeHtml(w.description) : ''}</option>`).join('');
    } catch (e) {
        select.innerHTML = '<option value="">Failed to load workflows</option>';
    }
    view.refresh();
}

function openModal(title, submit) {
    document.getElementById('job-modal-title').textContent = title;
    document.getElementById('job-modal-submit').textContent = submit;
    document.getElementById('job-modal').style.display = 'flex'; // display-ok: a dialog is shown as the flex container the .modal rule centres (modal_chrome and the close census read it)
}

export function showJobModal() {
    const v = jobView();
    editingJobId = null;
    openedJob = null;
    repoOffer = '';
    v.reset(); // every field at its default, no errors, an empty status line
    // No folder is chosen for the person: the Settings default if they set one, else empty and required, never the home folder (as New Agent has it, #5989; #9958).
    if (state.settings?.default_working_dir) v.set('repo_path', state.settings.default_working_dir);
    v.fold(false);
    openModal('New job', 'Create job');
    loadWorkflowOptions().then(() => { if (noOwnWorkflows && editingJobId === null) v.set('job_type', 'prompt'); }); // a first job with no workflow of the person's own to pick (none, or only the example) opens on the Agent prompt (#9297, #9965)
    document.getElementById('cron-preview').textContent = '';
    checkSchedule();
    document.getElementById('job-modal-name').focus();
}

export async function editScheduledJob(jobId) {
    // The job as the server has it now, not the list this page last polled (#4423).
    let job = null;
    try {
        const resp = await fetch(`/api/scheduled/jobs/${encodeURIComponent(jobId)}`);
        if (resp.ok) job = await resp.json();
    } catch { /* below */ }
    if (!job || job.error) { showToast('Could not load the job. Try again.', true); return; }

    const v = jobView();
    editingJobId = jobId;
    repoOffer = '';
    v.reset();
    openModal('Edit job', 'Save changes');
    const type = job.job_type || (job.workflow_id ? 'workflow' : 'prompt');
    for (const [k, val] of Object.entries({
        job_type: type, name: job.name, description: job.description || '', cron_expr: job.cron_expr, timezone: job.timezone || 'UTC', repo_path: job.repo_path || '',
        base_branch: job.base_branch || '', agent_type: job.agent_type || 'claude', prompt: job.prompt || '', max_duration_s: job.max_duration_s || 3600, cleanup_worktree: !!job.cleanup_worktree, no_worktree: job.no_worktree === 1, flags: job.flags || '',
    })) v.set(k, val);
    document.getElementById('cron-preview').textContent = '';
    // Nothing a job already has is hidden: More options opens when it holds something other than the defaults.
    v.fold(!!(job.description || (job.timezone && job.timezone !== LOCAL_ZONE) || (job.max_duration_s && job.max_duration_s !== 3600) || job.flags || (job.base_branch && job.base_branch !== 'main') || job.no_worktree === 1));
    document.getElementById('job-modal-flags').dispatchEvent(new Event('input')); // the flag shortcuts show which flags are on
    if (type === 'workflow') {
        await loadWorkflowOptions();
        v.set('workflow_id', job.workflow_id ? String(job.workflow_id) : '');
    }
    openedJob = jobFormValues();
    checkSchedule();
}

/** The dialog is shown again as it was left (New workflow was opened from it), with the workflow list read again so a workflow just made is in it (#9297). */
export function reshowJobModal() {
    const modal = document.getElementById('job-modal');
    if (!modal) return;
    modal.style.display = 'flex'; // display-ok: the same inline state openModal sets
    loadWorkflowOptions();
}

export function hideJobModal() {
    const modal = document.getElementById('job-modal');
    if (modal) modal.style.display = 'none'; // display-ok: the same inline state the dialog was opened with
}
