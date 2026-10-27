/* The New job / Edit job dialog (#7908): a settings_view in form mode. The fields are drawn from the spec below (label above, Required, the first invalid field focused, a status line under the
 * form); what is the job's own stays here: the schedule picker with its sentence, the workflow list, the time limit in words, the request. The ids of the controls are the page's contract and stay. */
import { mountSettingsView } from './settings_view.js';
import { ensureBuilt } from './lazy_dom.js';
import { escapeHtml, showToast } from './utils.js';
import { changedFields, NOTHING_TO_SAVE } from './settings_diff.js';
import { cronWords, atWords } from './job_words.js';
import { limitSeconds, limitParts } from './time_limit.js';

let view = null;
let editingJobId = null;  // non-null when editing an existing job
let openedJob = null;     // what the editor showed for the job it opened (#4423): Save sends only what the person changed since
let noWorkflows = false;  // the workflow list came back empty: the form says so and offers to make one

const DEFAULT_CRON = '0 * * * *';
const PRESETS = [['Every hour', DEFAULT_CRON], ['Every 6 hours', '0 */6 * * *'], ['Every day at 02:00', '0 2 * * *'], ['Mondays at 09:00', '0 9 * * 1'], ['Custom', '']];

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
const zoneMessage = tz => (zoneKnown(tz || 'UTC') ? '' : `"${tz}" is not a time zone name. Use one like UTC or Europe/Berlin.`);

/** aria-invalid is "true" or absent: an empty attribute reads as false to a screen reader. */
function markInvalid(e, bad) { if (bad) e.setAttribute('aria-invalid', 'true'); else e.removeAttribute('aria-invalid'); }

// -- the schedule picker: presets, a cron field behind Custom, one sentence for what it means ------------

function pickPreset(btn) {
    document.querySelectorAll('#sched-picker .sched-preset').forEach(b => press(b, b === btn));
    const cron = btn.dataset.cron;
    const cronInput = document.getElementById('job-modal-cron');
    const customRow = document.getElementById('sched-custom-row');
    if (cron === '') {
        if (customRow) customRow.hidden = false;
        if (cronInput) cronInput.focus();
    } else {
        if (customRow) customRow.hidden = true;
        if (cronInput) cronInput.value = cron;
    }
    checkSchedule();
    view && view.refresh();
}

/** The cron expression in the picker: the matching preset looks chosen, anything else is Custom with its field shown. */
function showCron(expr) {
    const isPreset = PRESETS.some(([, c]) => c !== '' && c === expr);
    document.getElementById('job-modal-cron').value = expr;
    document.querySelectorAll('#sched-picker .sched-preset').forEach(b => press(b, isPreset ? b.dataset.cron === expr : b.dataset.cron === ''));
    document.getElementById('sched-custom-row').hidden = isPreset;
}

/** "Runs every day at 02:00 (UTC). Next: tomorrow 02:00, your time." The schedule as the Jobs page says it. */
export function previewWords(expr, tz, nextIso) {
    const words = cronWords(expr);
    const runs = words.startsWith('Schedule:') ? `Runs on the schedule ${expr}` : 'Runs ' + words.charAt(0).toLowerCase() + words.slice(1);
    const next = nextIso ? ` Next: ${atWords(nextIso)}, your time.` : '';
    return `${runs} (${tz}).${next}`;
}

let checkSeq = 0;
async function checkSchedule() {
    const my = ++checkSeq;
    const expr = document.getElementById('job-modal-cron').value.trim();
    const tz = document.getElementById('job-modal-timezone').value.trim() || 'UTC';
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
            const presets = el('div', 'sched-presets');
            for (const [label, cron] of PRESETS) {
                const b = el('button', 'sched-preset', label); b.type = 'button'; b.dataset.cron = cron; press(b, cron === DEFAULT_CRON);
                b.addEventListener('click', () => pickPreset(b));
                presets.append(b);
            }
            const row = el('div', 'sched-custom-row'); row.id = 'sched-custom-row'; row.hidden = true;
            const lab = el('label', 'sched-cron-field', 'Cron expression');
            const input = el('input', 'sched-cron-input'); input.type = 'text'; input.id = 'job-modal-cron'; input.placeholder = '0 2 * * *'; input.value = DEFAULT_CRON; input.setAttribute('aria-describedby', 'sched-cron-help cron-preview');
            input.addEventListener('input', () => checkSchedule());
            lab.append(input);
            const help = el('div', 'job-help'); help.id = 'sched-cron-help';
            const code = el('code', '', '0 2 * * *');
            help.append('Five fields: minute, hour, day of month, month, day of week. ', code, ' is every day at 02:00.');
            row.append(lab, help);
            const preview = el('div', 'sched-preview'); preview.id = 'cron-preview'; preview.setAttribute('role', 'status');
            slot.append(presets, row, preview);
            return {
                get: () => input.value.trim(),
                set: v => showCron(v || ''),
                invalid: on => { if (on || !document.getElementById('cron-preview').classList.contains('sched-preview-bad')) markInvalid(input, on); }, // the cron box itself carries the mark a screen reader reads
                focus: () => { const custom = slot.querySelector('.sched-preset[data-cron=""]'); if (!input.value.trim() && custom) pickPreset(custom); (input.closest('[hidden]') ? slot.querySelector('.sched-preset.active') : input)?.focus(); }, // the field is behind Custom: choose it, which shows the field
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
                slot.classList.add('job-type-toggle');
                let value = 'workflow';
                const buttons = [['workflow', 'account_tree', 'Workflow'], ['prompt', 'smart_toy', 'Agent prompt']].map(([type, icon, label]) => {
                    const b = el('button', 'job-type-btn'); b.type = 'button'; b.dataset.type = type;
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
        { key: 'workflow_id', type: 'select', id: 'job-modal-workflow', label: 'Workflow', required: true, requiredMessage: 'Pick the workflow this job runs.', options: [{ value: '', label: 'Select a workflow\u2026' }], visibleWhen: workflow },
        {
            key: 'no_workflows', type: 'notice', visibleWhen: v => workflow(v) && noWorkflows,
            render: slot => {
                slot.id = 'job-modal-no-workflows'; slot.classList.add('job-no-workflows');
                const b = el('button', 'btn btn-small', 'Create a workflow'); b.type = 'button'; b.setAttribute('data-on-click', 'job-create-workflow');
                slot.append(el('span', '', 'No workflows yet. A job runs a workflow on a schedule.'), ' ', b);
            },
        },
        { key: 'repo_path', type: 'path', id: 'job-modal-repo', label: 'Repository path', required: true, requiredMessage: 'Enter the repository path.', placeholder: '/path/to/repo', default: host.dataset.coralRoot || '', attrs: { 'data-coral-root': host.dataset.coralRoot || '' }, visibleWhen: prompt },
        {
            key: 'agent_type', type: 'select', id: 'job-modal-agent', label: 'Agent', default: 'claude', visibleWhen: prompt,
            options: [{ value: 'claude', label: 'Claude' }, { value: 'agy', label: 'Antigravity (agy)' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'Pi' }],
            setup: e => e.setAttribute('data-on-change', 'flag-agent-change'),
        },
        { key: 'prompt', type: 'textarea', id: 'job-modal-prompt', label: 'Prompt', required: true, requiredMessage: 'Write the prompt the agent runs.', rows: 4, placeholder: 'Run the full test suite and report failures...', visibleWhen: prompt },
        scheduleField(),
        { key: 'extras', type: 'heading', fold: true, id: 'job-modal-more', label: 'More options' },
        { key: 'description', type: 'text', id: 'job-modal-description', label: 'Description', placeholder: 'e.g. Runs the full test suite' },
        {
            key: 'timezone', type: 'text', id: 'job-modal-timezone', label: 'Time zone', default: 'UTC', placeholder: 'UTC',
            validate: v => zoneMessage(String(v || '').trim() || 'UTC'),
            setup: e => { e.classList.add('sched-tz-input'); e.addEventListener('input', () => checkSchedule()); },
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
        { key: 'cleanup_worktree', type: 'toggle', id: 'job-modal-cleanup', label: 'Remove the worktree when the run ends', default: true, visibleWhen: prompt },
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
        timezone: String(v.timezone || '').trim() || 'UTC',
        max_duration_s: (limit && limit.seconds) || 3600,
        cleanup_worktree: v.cleanup_worktree ? 1 : 0,
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
    if (data.error) throw new Error(data.error);
    showToast(isEdit ? 'Job updated' : 'Job created');
    hideJobModal();
    document.dispatchEvent(new CustomEvent('job-saved', { detail: { id: data.id } })); // the Jobs page reads the list again and opens it
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
    v.reset(); // every field at its default, no errors, an empty status line
    v.fold(false);
    openModal('New job', 'Create job');
    loadWorkflowOptions();
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
    v.reset();
    openModal('Edit job', 'Save changes');
    const type = job.job_type || (job.workflow_id ? 'workflow' : 'prompt');
    for (const [k, val] of Object.entries({
        job_type: type, name: job.name, description: job.description || '', cron_expr: job.cron_expr, timezone: job.timezone || 'UTC', repo_path: job.repo_path || '',
        base_branch: job.base_branch || '', agent_type: job.agent_type || 'claude', prompt: job.prompt || '', max_duration_s: job.max_duration_s || 3600, cleanup_worktree: !!job.cleanup_worktree, flags: job.flags || '',
    })) v.set(k, val);
    document.getElementById('cron-preview').textContent = '';
    // Nothing a job already has is hidden: More options opens when it holds something other than the defaults.
    v.fold(!!(job.description || (job.timezone && job.timezone !== 'UTC') || (job.max_duration_s && job.max_duration_s !== 3600) || job.flags || (job.base_branch && job.base_branch !== 'main')));
    document.getElementById('job-modal-flags').dispatchEvent(new Event('input')); // the flag shortcuts show which flags are on
    if (type === 'workflow') {
        await loadWorkflowOptions();
        v.set('workflow_id', job.workflow_id ? String(job.workflow_id) : '');
    }
    openedJob = jobFormValues();
    checkSchedule();
}

export function hideJobModal() {
    const modal = document.getElementById('job-modal');
    if (modal) modal.style.display = 'none'; // display-ok: the same inline state the dialog was opened with
}
