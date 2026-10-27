// The team page's Settings tab (#7744): the page is a settings_view, so its nav, rows, help, errors and save bar are the component's; this module is what is the team's own: what it loads, the
// shapes it saves, the presets editor, the Health check and Messaging parts (their own forms and Saves, held by the bar) and the read-only prompt preview.
import { importOnce } from './import_once.js';
import { escapeHtml, copyText, showToast } from './utils.js';
import { splitKey, serverUrl, isCloud, boardFetch } from './server_base.js';
import { rebaseChanges } from './settings_diff.js';
const { mountSettingsView } = await importOnce('./settings_view.js');
const { boardRenameControl } = await importOnce('./board_rename.js');
const { bindInfo } = await importOnce('./info_toggle.js');
const { refusalOf, answeredLocally } = await importOnce('./owner_refusal.js');
const { requireGoalSentence } = await importOnce('./task_goals.js');
const { createMessaging, XT_KEYS } = await importOnce('./team_cross_team_fields.js');
const { healthFields, healthToValues, saveHealth, HEALTH_KEYS } = await importOnce('./team_health_fields.js');
const { HEALTH_DEFAULTS } = await importOnce('./team_health_settings.js');
const { jsonError, presetNameText, presetInstructionsText, presetLabel, renderInspection } = await importOnce('./team_working_mode.js');

let _lastSection = 'workflow'; // the group the tab shows, kept when the page is drawn again (Cancel)
const MODE_KEYS = ['mode', 'dependency_guidance', 'asks_are_tasks', 'custom_instructions'];
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
    const st = openSettingsState(team, options);
    st.view = mountSettingsView(st.page, settingsViewOptions(st));
    wirePage(st);
    wireModeRow(st);
    wirePresetEditor(st);
    wirePromptPreview(st);
    return st.view;
}

function openSettingsState(team, options) {
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
    const st = { team, options, host, page, board, teamServer, workingModeURL, presetsURL, boardSettingsURL, inspectionURL, presets: [], workingMode: null, healthMonitorOn: true, healthBase: null, view: null }; // what the page's parts share

    // One read of everything the tab shows, started now: the mode list and the load both wait for it.
    st.dataReady = Promise.all([fetch(workingModeURL), fetch(presetsURL), fetch('/api/settings'), fetch(inspectionURL), fetch(boardSettingsURL).catch(() => null)]);
    st.dataReady.catch(() => {});
    // The recipient list: the team's active members (just the default and the saved name when the list cannot be read).
    st.membersReady = boardFetch(team, '/subscribers').then(async r => (r.ok ? (await r.json()).filter(m => m.is_active !== 0) : [])).catch(() => []);
    st.xt = createMessaging(team); // the Messaging group: its fields, its lines and its save
    st.modeOptions = () => (st.presets.length ? st.presets.map(p => ({ value: p.id, label: presetNameText(p) })) : DEFAULT_MODES);
    st.modeSelect = () => st.view.host.querySelector('select[name="mode"]');
    st.q = sel => st.view.host.querySelector(sel);
    return st;
}

function settingsViewOptions(st) {
    return {
        mode: 'settings',
        label: 'Team settings sections', groupLabel: 'Team settings group',
        lead: 'Only the Operator on this computer can change these.',
        group: _lastSection,
        onGroup: id => { _lastSection = id; },
        words: { failed: 'Could not save: ' },
        failure: m => m.replace(/^Could not save( the health check)?\.?\s*/i, '') || m,
        saveBar: { save: 'Save settings', cancel: 'Cancel', cancelAlways: !!st.options.closeDialog, onCancel: async () => { // every part back as it was read: the page is drawn again from the server (in the popout dialog Cancel is always there: it drops the edits and closes it)
            if (st.options.closeDialog) { st.options.closeDialog(); return; }
            await showTeamSettingsPage(st.team, st.options);
            const h = st.host.querySelector('.settings-pane:not([hidden]) .settings-pane-title'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } // the button that had the focus is gone: it goes to the open group's heading
        } },
        readOnly: key => (key === 'require_goal' && !answeredLocally(st.team) ? true : false), // only this computer changes it (the route refuses it through Coral Hub)
        groups: settingsGroups(st),
        load: loadSettings(st),
        save: saveSettings(st),
    };
}

function settingsGroups(st) {
    // Reset to defaults: every health field takes the default and the bar says to save (the held-delivery rule only when the server has it).
    function resetHealth(v) {
        const d = { ...HEALTH_DEFAULTS }; if (!st.healthBase || !st.healthBase.held_notice) delete d.held_notice;
        for (const [k, val] of Object.entries(healthToValues(d))) v.set(k, val);
        v.say('The defaults are filled in. Save to apply them.');
        st.q('input[name="on"]')?.focus();
    }
    return [
        { id: 'workflow', label: 'Workflow', icon: 'account_tree', hint: 'How agents work on this team.', fields: [
            { key: 'board_name', type: 'custom', label: 'Board name', help: 'Only the label changes: its agents, tasks and history stay.',
                render: slot => { slot.append(boardRenameControl(st.team, { onRenamed: () => { document.getElementById('team-page-title') && importOnce('./team_page.js').then(m => m.refreshTeamHeader?.()).catch(() => {}); importOnce('./render.js').then(m => m.scheduleLiveSessionsRender()); } })); } },
            { key: 'mode', type: 'select', label: 'Working mode', id: 'tsr-mode',
                help: { text: 'Instructions are saved with each task when it is first claimed.', about: 'working modes', more: 'Tasks already claimed keep their instructions. This setting gives guidance; it does not create worktrees by itself.' },
                options: async () => { await st.dataReady.catch(() => {}); return st.modeOptions(); } },
            { key: 'dependency_guidance', type: 'toggle', label: 'Guidance for dependent tasks', help: 'Tells agents how to work when a task waits on another.' },
            { key: 'asks_are_tasks', type: 'toggle', label: 'Requests for work are tasks', help: 'When an agent needs another agent to do something, it creates a task. Plain posts are for questions and status.' },
            { key: 'require_goal', type: 'toggle', label: 'Require a goal', help: requireGoalSentence },
            { key: 'custom_instructions', type: 'textarea', label: 'Additional instructions', help: 'Team-specific conventions, given to agents with each task.', wide: true, rows: 4, placeholder: 'Team-specific conventions' },
            { key: 'presets', type: 'custom', label: 'Presets', help: 'A preset saves with Save preset, not Save settings.', wide: true, render: slot => { slot.innerHTML = PRESET_EDITOR; } },
        ] },
        { id: 'health', domId: 'team-settings-health', label: 'Health check', icon: 'notifications', hint: 'When an agent that stopped working is noticed.', fields: healthFields({ members: () => st.membersReady, hasHeld: () => Boolean(st.healthBase && st.healthBase.held_notice), monitorOff: () => !st.healthMonitorOn, onReset: resetHealth, openSettings: () => window.showSettingsModal?.('agents') }) },
        { id: 'messaging', domId: 'team-settings-messaging', label: 'Messaging', icon: 'chat', hint: 'How the team\'s messages reach its agents.', fields: st.xt.fields() },
        { id: 'prompts', label: 'Prompts', icon: 'description', hint: 'Read-only preview of the prompts agents get.', render: p => { p.innerHTML = '<div class="prompt-inspection-content" aria-live="polite">Loading prompt inspection\u2026</div>'; } },
    ];
}

function loadSettings(st) {
    return async () => {
        const [modeResponse, presetsResponse, settingsResponse, inspectionResponse, boardSettingsResponse] = await st.dataReady;
        if (!modeResponse.ok) throw new Error('Could not load working mode. Close and reopen to retry.');
        if (!presetsResponse.ok) throw new Error(await jsonError(presetsResponse, 'Could not load workflow presets.'));
        st.workingMode = await modeResponse.json();
        st.presets = (await presetsResponse.json()).presets || [];
        st.renderPresets();
        // The all-Coral health switch lives in Settings (#5128); this page only reads it, for the Health check note.
        if (settingsResponse.ok) st.healthMonitorOn = String((await settingsResponse.json()).settings?.board_health_monitor ?? '').trim().toLowerCase() !== 'false'; // a boolean is stored as "False"
        let boardSettings = null, xtValues = {};
        if (boardSettingsResponse?.ok) {
            boardSettings = await boardSettingsResponse.json();
            if (boardSettings.health && typeof boardSettings.health === 'object') st.healthBase = JSON.parse(JSON.stringify(boardSettings.health)); else st.view.removeGroup('health'); // only when the settings GET returned a "health" object: not through Coral Hub
            let crossTeam = null;
            { // the machine's own answer; through Coral Hub the route may not be served (then null and the switches stay as they were)
                const stateResponse = await fetch(serverUrl(`/api/board/${st.board}/cross-team-state`, st.teamServer)).catch(() => null);
                crossTeam = stateResponse?.ok ? await stateResponse.json().catch(() => null) : null;
            }
            xtValues = await st.xt.load({ state: crossTeam, settings: boardSettings }).catch(() => st.xt.load({}));
        } else {
            st.view.removeGroup('health');
            // The board settings could not be loaded: through Coral Hub the owner-only settings can be refused (#5323): the Messaging group says why, in our words (and the Health check is not drawn).
            xtValues = await st.xt.load({ refusal: boardSettingsResponse ? await refusalOf(boardSettingsResponse, answeredLocally(st.team)) : '' });
        }
        st.q('.prompt-inspection-content').innerHTML = inspectionResponse.ok ? renderInspection(await inspectionResponse.json(), st.workingMode) : `<p class="sv-help">Prompt inspection: ${escapeHtml(await refusalOf(inspectionResponse, answeredLocally(st.team)))}</p>`;
        return { mode: st.workingMode.mode || 'none', dependency_guidance: Boolean(st.workingMode.dependency_guidance), asks_are_tasks: Boolean(st.workingMode.asks_are_tasks), ...xtValues, custom_instructions: st.workingMode.custom_instructions || '', require_goal: Boolean(boardSettings?.require_goal), ...(st.healthBase ? healthToValues(st.healthBase) : {}) };
    };
}

function saveSettings(st) {
        // What changed since the page loaded (the working mode is saved whole: what the server has now, with only the fields changed here, #4423).
    return async (changes, { before, values }) => {
        const modeChanged = MODE_KEYS.some(k => k in changes);
        const pick = o => Object.fromEntries(MODE_KEYS.map(k => [k, o[k]]));
        const saved = []; const failures = [];
        if (modeChanged) {
            try {
                const current = await fetch(st.workingModeURL);
                if (!current.ok) throw new Error(await jsonError(current, 'Could not read the working mode to save it.'));
                const fresh = await current.json();
                const body = rebaseChanges(pick(before), pick(values), { mode: fresh.mode || 'none', dependency_guidance: Boolean(fresh.dependency_guidance), asks_are_tasks: Boolean(fresh.asks_are_tasks), custom_instructions: fresh.custom_instructions || '' });
                const response = await fetch(st.workingModeURL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (!response.ok) failures.push(await jsonError(response, 'Could not save working mode.'));
                else { st.workingMode = await response.json(); saved.push(...MODE_KEYS); }
            } catch (error) { failures.push(error.message); }
        }
        if ('require_goal' in changes) {
            try {
                const response = await fetch(st.boardSettingsURL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'Operator', require_goal: values.require_goal }) });
                if (!response.ok) failures.push(await jsonError(response, 'Could not save require a goal.'));
                else saved.push('require_goal');
            } catch (error) { failures.push(error.message); }
        }
        if (HEALTH_KEYS.some(k => k in changes)) {
            try {
                const kept = await saveHealth(st.team, st.healthBase, values);
                st.healthBase = JSON.parse(JSON.stringify(kept));
                for (const [k, val] of Object.entries(healthToValues(kept))) st.view.set(k, val); // the server clamps every value: the fields show what it kept
                saved.push(...HEALTH_KEYS);
            } catch (error) { failures.push(error.message); }
        }
        if (XT_KEYS.some(k => k in changes)) {
            try { await st.xt.save(); saved.push(...XT_KEYS); } catch (error) { failures.push(error.message); }
        }
        if (failures.length) throw Object.assign(new Error(failures[0]), { saved });
        return { note: modeChanged ? 'Saved. Working mode applies on first claim.' : null, rebase: saved.filter(k => HEALTH_KEYS.includes(k) || XT_KEYS.includes(k)) };
    };
}

function wirePage(st) {
    st.page.view = st.view; // the page's settings_view (a test reads what changed through it)
    st.page.hasUnsaved = () => st.view.isDirty(); // read live by the leave-the-page question (team_working_mode.js)
    st.xt.bind(st.view);
    st.view.say('Loading\u2026');
    st.view.ready.then(() => { st.syncModeDescription(); st.xt.drawn(); }).catch(() => {}); // the line under the list follows the mode the load set
    st.view.ready.catch(error => { st.view.say(error.message, true); const c = st.q('.prompt-inspection-content'); if (c) c.textContent = 'Prompt inspection could not be loaded.'; st.xt.load({}).then(() => st.xt.drawn()).catch(() => {}); });
}

function wireModeRow(st) {
    // -- the Working mode row: the line under it, the docs link in its Learn more --------------------------
    const modeRow = st.q('.sv-row[data-key="mode"]');
    const modeDesc = document.createElement('p');
    modeDesc.className = 'sv-help sv-row-notice working-mode-desc'; modeDesc.id = 'working-mode-desc';
    modeRow.querySelector('.sv-control').after(modeDesc); // under the select
    st.modeSelect().setAttribute('aria-describedby', `${st.modeSelect().getAttribute('aria-describedby') || ''} working-mode-desc`.trim());
    const more = modeRow.querySelector('.sv-more');
    if (more) { const p = document.createElement('p'); const a = document.createElement('a'); a.href = '#'; a.className = 'working-mode-docs-link'; a.dataset.doc = 'teams'; a.textContent = 'Team working modes'; p.append(a); more.append(p); }
    st.page.addEventListener('click', event => {
        const docLink = event.target.closest('.working-mode-docs-link');
        if (!docLink) return;
        event.preventDefault();
        if (window.switchNavTab) window.switchNavTab('docs');
        importOnce('./lazy_panels.js').then(l => l.loadDocs()).then(m => m.selectDoc(docLink.dataset.doc)).catch(() => {});
    });
    // One line under the Working mode list: what the chosen mode means, from the preset (the server's description; a team's own preset has none, and the line is empty).
    function syncModeDescription() {
        const preset = st.presets.find(p => p.id === st.modeSelect().value);
        modeDesc.textContent = (preset && preset.id === 'none') ? 'No extra guidance.' : ((preset && preset.description) || '');
        modeDesc.hidden = !modeDesc.textContent;
    }
    st.modeSelect().addEventListener('change', syncModeDescription);

    st.syncModeDescription = syncModeDescription; // the load and the preset editor redraw the line
}

function wirePresetEditor(st) {
    // -- the preset editor: its own saves (POST, PUT, reset), not the bar's ------------------------------------
    const presetSelect = st.q('select[name="preset"]'), presetName = st.q('input[name="preset_name"]'), presetInstructions = st.q('textarea[name="preset_instructions"]');
    const presetState = st.q('.preset-state'), presetReset = st.q('.preset-reset'), presetSave = st.q('.preset-save');
    const selectedPreset = () => st.presets.find(p => p.id === presetSelect.value);
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
        presetSelect.innerHTML = st.presets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(presetLabel(p))}</option>`).join('');
        const select = st.modeSelect();
        st.presets.filter(p => ![...select.options].some(option => option.value === p.id)).forEach(p => select.add(new Option(presetNameText(p), p.id))); // the Working mode list names them all the same way: only the preset editor says which are built in (#6058 follow-up)
        if (st.workingMode?.mode && st.presets.some(p => p.id === st.workingMode.mode)) presetSelect.value = st.workingMode.mode;
        syncPresetForm();
        st.syncModeDescription();
    }
    presetSelect.onchange = () => {
        syncPresetForm();
        if (presetSelect.value) st.view.set('mode', presetSelect.value);
        st.syncModeDescription();
    };
    st.q('.preset-new').onclick = () => {
        const id = `custom-${Date.now().toString(36)}`;
        st.presets.push({ id, name: 'New preset', instructions: '', builtin: false, isNew: true });
        renderPresets();
        presetSelect.value = id;
        syncPresetForm();
        st.view.set('mode', id);
        st.syncModeDescription();
        presetName.focus();
    };
    presetSave.onclick = async () => {
        const preset = selectedPreset();
        if (!preset) return;
        const name = presetName.value.trim();
        const instructions = presetInstructions.value;
        if (!name) { st.view.say('Preset name is required.', true); return; }
        if (!preset.builtin && !instructions.trim()) { st.view.say('Preset instructions are required.', true); return; }
        presetSave.disabled = true;
        try {
            const isNew = Boolean(preset.isNew);
            const url = isNew ? st.presetsURL : `${st.presetsURL}/${encodeURIComponent(preset.id)}`;
            // A PUT replaces name and instructions together, so a field the person left alone would put back the value this form opened with over a change another client made meanwhile: read the preset again now and apply only what was changed here (#4423).
            let toSave = { name, instructions };
            if (!isNew && preset.openedForm) {
                try {
                    const again = await fetch(st.presetsURL);
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
            st.view.say('Workflow preset saved.');
        } catch (error) { st.view.say(error.message, true); }
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
            const response = await fetch(`${st.presetsURL}/${encodeURIComponent(preset.id)}/reset`, { method: 'POST' });
            if (!response.ok) throw new Error(await jsonError(response, 'Could not reset preset.'));
            const result = await response.json();
            Object.assign(preset, result.preset || result, { overridden: false });
            syncPresetForm(); st.view.say('Built-in preset reset to the shipped default.');
        } catch (error) { st.view.say(error.message, true); }
        finally { presetReset.disabled = false; }
    };

    st.renderPresets = renderPresets; // the load draws the presets once it has read them
}

function wirePromptPreview(st) {
    // -- the prompt preview: one role at a time, Copy takes the text of the one shown (UI audit #5589, finding 10) ----
    const inspection = st.q('.prompt-inspection-content');
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
}
