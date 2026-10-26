// The team page's Settings tab (#7744): the page is a settings_view, so its nav, rows, help, errors and save bar are the component's; this module is what is the team's own: what it loads, the
// shapes it saves, the presets editor, the Health check and Messaging parts (their own forms and Saves, held by the bar) and the read-only prompt preview.
import { importOnce } from './import_once.js';
import { escapeHtml, copyText, showToast } from './utils.js';
import { splitKey, serverUrl, isCloud } from './server_base.js';
import { rebaseChanges } from './settings_diff.js';
const { mountSettingsView } = await importOnce('./settings_view.js');
const { boardRenameControl } = await importOnce('./board_rename.js');
const { bindInfo } = await importOnce('./info_toggle.js');
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js');
const { requireGoalSentence } = await importOnce('./task_goals.js');
const { jsonError, presetNameText, presetInstructionsText, presetLabel, renderInspection } = await importOnce('./team_working_mode.js');

let _lastSection = 'workflow'; // the group the tab shows, kept when the page is drawn again (Cancel)
const MODE_KEYS = ['mode', 'dependency_guidance', 'custom_instructions'];
const DEFAULT_MODES = [{ value: 'none', label: 'None' }, { value: 'shared_checkout', label: 'Shared checkout' }, { value: 'worktrees', label: 'Worktrees' }];

const PRESET_EDITOR = `<details class="disclosure team-settings-section workflow-presets-section preset-editor">
  <summary>Edit presets</summary>
  <label>Preset<select name="preset"></select></label>
  <div class="workflow-preset-actions"><button type="button" class="btn preset-new">New preset</button><button type="button" class="btn preset-reset" hidden>Reset built-in</button></div>
  <label>Preset name<input name="preset_name" maxlength="80" autocomplete="off"></label>
  <label>Preset instructions<textarea name="preset_instructions" rows="5" maxlength="4096" placeholder="Instructions agents should follow"></textarea></label>
  <p class="sv-help preset-state"></p>
  <button type="button" class="btn preset-save">Save preset</button>
</details>`;

/** Draws the team's Settings tab into options.page. */
export async function showTeamSettingsPage(team, options = {}) {
    const host = options.page;
    const page = document.createElement('section');
    page.id = 'team-settings-workspace';
    page.className = 'team-settings-workspace team-settings-page';
    page.setAttribute('aria-label', 'Team settings');
    page.dataset.team = team; // which team this page is for: the tab keeps a page with unsaved changes when it is opened again
    host.replaceChildren(page);

    const { server: teamServer, name: teamName } = splitKey(team);
    const board = encodeURIComponent(teamName);
    const workingModeURL = serverUrl(`/api/board/${board}/working-mode`, teamServer);
    const presetsURL = serverUrl(`/api/board/${board}/working-mode/presets`, teamServer);
    const boardSettingsURL = serverUrl(`/api/board/${board}/settings`, teamServer);
    const inspectionURL = serverUrl(`/api/settings/prompt-inspection?board=${board}`, teamServer);
    let presets = [], workingMode = null, healthMonitorOn = true, healthApi = null, crossApi = null, view = null;

    // One read of everything the tab shows, started now: the mode list and the load both wait for it.
    const dataReady = Promise.all([fetch(workingModeURL), fetch(presetsURL), fetch('/api/settings'), fetch(inspectionURL), fetch(boardSettingsURL).catch(() => null)]);
    dataReady.catch(() => {});

    const modeOptions = () => (presets.length ? presets.map(p => ({ value: p.id, label: presetNameText(p) })) : DEFAULT_MODES);
    const modeSelect = () => view.host.querySelector('select[name="mode"]');
    const q = sel => view.host.querySelector(sel);

    view = mountSettingsView(page, {
        mode: 'settings',
        label: 'Team settings sections', groupLabel: 'Team settings group',
        lead: 'Only the Operator on this computer can change these.',
        group: _lastSection,
        onGroup: id => { _lastSection = id; },
        words: { failed: 'Could not save: ' },
        failure: m => m.replace(/^Could not save( the health check)?\.?\s*/i, '') || m,
        saveBar: { save: 'Save settings', cancel: 'Cancel', onCancel: async () => { // every part back as it was read: the page is drawn again from the server
            await showTeamSettingsPage(team, options);
            const h = host.querySelector('.settings-pane:not([hidden]) .settings-pane-title'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } // the button that had the focus is gone: it goes to the open group's heading
        } },
        readOnly: key => (key === 'require_goal' && !answeredLocally(team) ? true : false), // only this computer changes it (the route refuses it through Coral Hub)
        parts: () => [healthApi && { dirty: () => healthApi.dirty(), save: () => healthApi.save() }, crossApi && { dirty: () => crossApi.dirty(), save: () => crossApi.save() }],
        groups: [
            { id: 'workflow', label: 'Workflow', icon: 'account_tree', hint: 'How agents work on this team.', fields: [
                { key: 'board_name', type: 'custom', label: 'Board name', help: 'Only the label changes: its agents, tasks and history stay.',
                    render: slot => { slot.append(boardRenameControl(team, { onRenamed: () => { document.getElementById('team-page-title') && importOnce('./team_page.js').then(m => m.refreshTeamHeader?.()).catch(() => {}); importOnce('./render.js').then(m => m.scheduleLiveSessionsRender()); } })); } },
                { key: 'mode', type: 'select', label: 'Working mode', id: 'tsr-mode',
                    help: { text: 'Instructions are saved with each task when it is first claimed.', about: 'working modes', more: 'Tasks already claimed keep their instructions. This setting gives guidance; it does not create worktrees by itself.' },
                    options: async () => { await dataReady.catch(() => {}); return modeOptions(); } },
                { key: 'dependency_guidance', type: 'toggle', label: 'Include dependent-queue guidance', help: 'Tells agents how to work when a task waits on another.' },
                { key: 'require_goal', type: 'toggle', label: 'Require a goal', help: requireGoalSentence },
                { key: 'custom_instructions', type: 'textarea', label: 'Additional instructions', help: 'Team-specific conventions, given to agents with each task.', wide: true, rows: 4, placeholder: 'Team-specific conventions' },
                { key: 'presets', type: 'custom', label: 'Presets', help: 'A preset saves with Save preset, not Save settings.', wide: true, render: slot => { slot.innerHTML = PRESET_EDITOR; } },
            ] },
            { id: 'health', label: 'Health check', icon: 'notifications', hint: 'When an agent that stopped working is noticed.', render: p => { p.innerHTML = '<div id="team-settings-health"><p class="sv-help ct-loading" role="status">Loading\u2026</p></div>'; } },
            { id: 'messaging', label: 'Messaging', icon: 'chat', hint: 'How the team\'s messages reach its agents.', render: p => { p.innerHTML = '<div id="team-settings-messaging"><p class="sv-help ct-loading" role="status">Loading\u2026</p></div>'; } },
            { id: 'prompts', label: 'Prompts', icon: 'description', hint: 'Read-only preview of the prompts agents get.', render: p => { p.innerHTML = '<div class="prompt-inspection-content" aria-live="polite">Loading prompt inspection\u2026</div>'; } },
        ],
        load: async () => {
            const [modeResponse, presetsResponse, settingsResponse, inspectionResponse, boardSettingsResponse] = await dataReady;
            if (!modeResponse.ok) throw new Error('Could not load working mode. Close and reopen to retry.');
            if (!presetsResponse.ok) throw new Error(await jsonError(presetsResponse, 'Could not load workflow presets.'));
            workingMode = await modeResponse.json();
            presets = (await presetsResponse.json()).presets || [];
            renderPresets();
            // The all-Coral health switch lives in Settings (#5128); this page only reads it, for the Health check note.
            if (settingsResponse.ok) healthMonitorOn = String((await settingsResponse.json()).settings?.board_health_monitor ?? '').trim().toLowerCase() !== 'false'; // a boolean is stored as "False"
            let boardSettings = null;
            if (boardSettingsResponse?.ok) {
                boardSettings = await boardSettingsResponse.json();
                if (boardSettings.health && typeof boardSettings.health === 'object') await addHealth(boardSettings.health).catch(() => {}); // only when the settings GET returned a "health" object: not through Coral Hub
                let crossTeam = null;
                { // the machine's own answer; through Coral Hub the route may not be served (then null and the switches stay as they were)
                    const stateResponse = await fetch(serverUrl(`/api/board/${board}/cross-team-state`, teamServer)).catch(() => null);
                    crossTeam = stateResponse?.ok ? await stateResponse.json().catch(() => null) : null;
                }
                await fillMessaging({ state: crossTeam, settings: boardSettings }).catch(() => fillMessaging({}));
            } else {
                // The board settings could not be loaded: through Coral Hub the owner-only settings can be refused (#5323): the Messaging group says why, in our words (and the Health check is not drawn).
                await fillMessaging({ refusal: boardSettingsResponse ? await refusalOf(boardSettingsResponse, answeredLocally(team)) : '' });
            }
            q('.prompt-inspection-content').innerHTML = inspectionResponse.ok ? renderInspection(await inspectionResponse.json(), workingMode) : `<p class="sv-help">Prompt inspection: ${escapeHtml(await refusalOf(inspectionResponse, answeredLocally(team)))}</p>`;
            return { mode: workingMode.mode || 'none', dependency_guidance: Boolean(workingMode.dependency_guidance), custom_instructions: workingMode.custom_instructions || '', require_goal: Boolean(boardSettings?.require_goal) };
        },
        // What changed since the page loaded (the working mode is saved whole: what the server has now, with only the fields changed here, #4423).
        save: async (changes, { before, values }) => {
            const modeChanged = MODE_KEYS.some(k => k in changes);
            const pick = o => Object.fromEntries(MODE_KEYS.map(k => [k, o[k]]));
            const saved = []; let failure = '';
            if (modeChanged) {
                try {
                    const current = await fetch(workingModeURL);
                    if (!current.ok) throw new Error(await jsonError(current, 'Could not read the working mode to save it.'));
                    const fresh = await current.json();
                    const body = rebaseChanges(pick(before), pick(values), { mode: fresh.mode || 'none', dependency_guidance: Boolean(fresh.dependency_guidance), custom_instructions: fresh.custom_instructions || '' });
                    const response = await fetch(workingModeURL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                    if (!response.ok) failure = await jsonError(response, 'Could not save working mode.');
                    else { workingMode = await response.json(); saved.push(...MODE_KEYS); }
                } catch (error) { failure = error.message; }
            }
            if ('require_goal' in changes) {
                try {
                    const response = await fetch(boardSettingsURL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', require_goal: values.require_goal }) });
                    if (!response.ok) failure = await jsonError(response, 'Could not save require a goal.');
                    else saved.push('require_goal');
                } catch (error) { failure = error.message; }
            }
            if (failure) throw Object.assign(new Error(failure), { saved });
            return { note: modeChanged ? 'Saved. Working mode applies on first claim.' : null };
        },
    });
    view.say('Loading\u2026');
    view.ready.then(() => syncModeDescription()).catch(() => {}); // the line under the list follows the mode the load set
    view.ready.catch(error => { view.say(error.message, true); const c = q('.prompt-inspection-content'); if (c) c.textContent = 'Prompt inspection could not be loaded.'; fillMessaging({}).catch(() => {}); });

    // -- the Working mode row: the line under it, the docs link in its Learn more --------------------------
    const modeRow = q('.sv-row[data-key="mode"]');
    const modeDesc = document.createElement('p');
    modeDesc.className = 'sv-help sv-row-note working-mode-desc'; modeDesc.id = 'working-mode-desc';
    modeRow.querySelector('.sv-control').after(modeDesc); // under the select
    modeSelect().setAttribute('aria-describedby', `${modeSelect().getAttribute('aria-describedby') || ''} working-mode-desc`.trim());
    const more = modeRow.querySelector('.sv-more');
    if (more) { const p = document.createElement('p'); const a = document.createElement('a'); a.href = '#'; a.className = 'working-mode-docs-link'; a.dataset.doc = 'teams'; a.textContent = 'Team working modes'; p.append(a); more.append(p); }
    page.addEventListener('click', event => {
        const docLink = event.target.closest('.working-mode-docs-link');
        if (!docLink) return;
        event.preventDefault();
        if (window.switchNavTab) window.switchNavTab('docs');
        importOnce('./lazy_panels.js').then(l => l.loadDocs()).then(m => m.selectDoc(docLink.dataset.doc)).catch(() => {});
    });
    // One line under the Working mode list: what the chosen mode means, from the preset (the server's description; a team's own preset has none, and the line is empty).
    function syncModeDescription() {
        const preset = presets.find(p => p.id === modeSelect().value);
        modeDesc.textContent = (preset && preset.id === 'none') ? 'No extra guidance.' : ((preset && preset.description) || '');
        modeDesc.hidden = !modeDesc.textContent;
    }
    modeSelect().addEventListener('change', syncModeDescription);

    // -- the preset editor: its own saves (POST, PUT, reset), not the bar's ------------------------------------
    const presetSelect = q('select[name="preset"]'), presetName = q('input[name="preset_name"]'), presetInstructions = q('textarea[name="preset_instructions"]');
    const presetState = q('.preset-state'), presetReset = q('.preset-reset'), presetSave = q('.preset-save');
    const selectedPreset = () => presets.find(p => p.id === presetSelect.value);
    function syncPresetForm() {
        const preset = selectedPreset();
        if (!preset) return;
        presetName.value = presetNameText(preset);
        presetInstructions.value = presetInstructionsText(preset);
        preset.openedForm = { name: presetName.value, instructions: presetInstructions.value }; // what the form opened with: Save applies only what the person changed to the preset as the server has it then
        // Through Coral Hub a preset can be created but not changed or reset (the Hub refuses the PUT and the reset, #4274): those buttons are not drawn, and an existing preset reads as read-only with the reason in its status line.
        const hubLocked = isCloud() && !preset.isNew;
        presetName.readOnly = Boolean(preset.builtin) || hubLocked;
        presetInstructions.readOnly = hubLocked;
        presetSave.hidden = hubLocked;
        presetReset.hidden = !preset.builtin || !preset.overridden || isCloud();
        presetSave.textContent = preset.builtin ? 'Save built-in override' : 'Save preset';
        presetState.textContent = hubLocked ? 'Through Coral Hub a preset can be added but not changed: edit it in Coral on that computer.' : '';
    }
    function renderPresets() {
        presetSelect.innerHTML = presets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(presetLabel(p))}</option>`).join('');
        const select = modeSelect();
        presets.filter(p => ![...select.options].some(option => option.value === p.id)).forEach(p => select.add(new Option(presetNameText(p), p.id))); // the Working mode list names them all the same way: only the preset editor says which are built in (#6058 follow-up)
        if (workingMode?.mode && presets.some(p => p.id === workingMode.mode)) presetSelect.value = workingMode.mode;
        syncPresetForm();
        syncModeDescription();
    }
    presetSelect.onchange = () => {
        syncPresetForm();
        if (presetSelect.value) view.set('mode', presetSelect.value);
        syncModeDescription();
    };
    q('.preset-new').onclick = () => {
        const id = `custom-${Date.now().toString(36)}`;
        presets.push({ id, name: 'New preset', instructions: '', builtin: false, isNew: true });
        renderPresets();
        presetSelect.value = id;
        syncPresetForm();
        view.set('mode', id);
        syncModeDescription();
        presetName.focus();
    };
    presetSave.onclick = async () => {
        const preset = selectedPreset();
        if (!preset) return;
        const name = presetName.value.trim();
        const instructions = presetInstructions.value;
        if (!name) { view.say('Preset name is required.', true); return; }
        if (!preset.builtin && !instructions.trim()) { view.say('Preset instructions are required.', true); return; }
        presetSave.disabled = true;
        try {
            const isNew = Boolean(preset.isNew);
            const url = isNew ? presetsURL : `${presetsURL}/${encodeURIComponent(preset.id)}`;
            // A PUT replaces name and instructions together, so a field the person left alone would put back the value this form opened with over a change another client made meanwhile: read the preset again now and apply only what was changed here (#4423).
            let toSave = { name, instructions };
            if (!isNew && preset.openedForm) {
                try {
                    const again = await fetch(presetsURL);
                    const fresh = again.ok ? ((await again.json()).presets || []).find(p => p.id === preset.id) : null;
                    if (fresh) toSave = rebaseChanges(preset.openedForm, { name, instructions }, { name: presetNameText(fresh), instructions: presetInstructionsText(fresh) });
                } catch { /* save what the form holds */ }
            }
            const body = preset.builtin ? { name: toSave.name, instructions: toSave.instructions } : { id: preset.id, name: toSave.name, instructions: toSave.instructions };
            const response = await fetch(url, { method: isNew ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error(await jsonError(response, 'Could not save preset.'));
            const result = await response.json();
            const saved = result.preset || result;
            preset.isNew = false;
            if (preset.builtin) preset.overridden = true;
            Object.assign(preset, saved, { name: toSave.name, instructions: toSave.instructions, builtin: Boolean(saved.builtin ?? preset.builtin) });
            renderPresets(); presetSelect.value = preset.id; syncPresetForm();
            view.say('Workflow preset saved.');
        } catch (error) { view.say(error.message, true); }
        finally { presetSave.disabled = false; }
    };
    // Enter in the preset name box is "Save preset", not the page's Save.
    presetName.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        if (!presetSave.hidden) presetSave.click();
    });
    presetReset.onclick = async () => {
        const preset = selectedPreset();
        if (!preset?.builtin) return;
        presetReset.disabled = true;
        try {
            const response = await fetch(`${presetsURL}/${encodeURIComponent(preset.id)}/reset`, { method: 'POST' });
            if (!response.ok) throw new Error(await jsonError(response, 'Could not reset preset.'));
            const result = await response.json();
            Object.assign(preset, result.preset || result, { overridden: false });
            syncPresetForm(); view.say('Built-in preset reset to the shipped default.');
        } catch (error) { view.say(error.message, true); }
        finally { presetReset.disabled = false; }
    };

    // -- the Health check and Messaging groups: their forms, saved by the page's bar ---------------------------
    async function addHealth(health) {
        const m = await importOnce('./team_health_settings.js');
        const slot = q('#team-settings-health');
        slot.replaceChildren();
        if (!healthMonitorOn) {
            const note = document.createElement('p');
            note.className = 'sv-help health-global-off'; note.setAttribute('role', 'status');
            note.append('Team health checks are turned off for all of Coral, so this team\'s check will not run. Turn on "Team health checks" in ');
            const link = document.createElement('button');
            link.type = 'button'; link.className = 'working-mode-settings-link'; link.textContent = 'Settings';
            link.addEventListener('click', () => window.showSettingsModal?.('agents'));
            note.append(link, '. It takes effect after Coral restarts.');
            slot.before(note);
        }
        healthApi = await m.mountHealthSettings(slot, team, health, { embedded: true });
    }
    async function fillMessaging(info) {
        const slot = q('#team-settings-messaging');
        if (!slot) return;
        const m = await importOnce('./team_cross_team_settings.js');
        crossApi = await m.mountCrossTeamSettings(slot, team, info || {}, { embedded: true });
    }
    page.addEventListener('health-saved', () => view.refresh()); page.addEventListener('cross-team-saved', () => view.refresh());

    // -- the prompt preview: one role at a time, Copy takes the text of the one shown (UI audit #5589, finding 10) ----
    const inspection = q('.prompt-inspection-content');
    bindInfo(inspection);
    inspection.addEventListener('change', event => {
        if (!event.target.matches('.prompt-inspection-role')) return;
        for (const card of inspection.querySelectorAll('.prompt-inspection-card')) card.hidden = card.dataset.role !== event.target.value;
    });
    inspection.addEventListener('click', async event => {
        if (!event.target.closest('.prompt-inspection-copy')) return;
        const card = inspection.querySelector('.prompt-inspection-card:not([hidden])');
        if (!card) return;
        // Every text of the role, the folded ones too (innerText leaves out what a closed details hides).
        const parts = [card.querySelector('h4')?.textContent.trim() || ''];
        for (const fragment of card.querySelectorAll('.prompt-inspection-fragment')) parts.push(`${fragment.querySelector('h5, summary')?.textContent.trim() || ''}\n${fragment.querySelector('pre')?.textContent || ''}`);
        if (await copyText(parts.join('\n\n'))) showToast('Copied'); else showToast('Could not copy: select the text and copy it', true);
    });
    return view;
}
