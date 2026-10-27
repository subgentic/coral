/* Moved out of modals.js as it was (#3844): no behaviour change. */
import { importOnce } from './import_once.js';
const { ALL_CAPABILITIES } = await importOnce('./agent_presets.js');
const { PERMISSION_MODE_DESCRIPTIONS, CODEX_AUTO_DESCRIPTION, CODEX_NETWORK_MODES, _updatePermModeDescription, defaultPermissionMode, syncDefaultPermissionMode, trackPermissionPick, _hasPermFlag, _normalizePermFlagsForAgent, _permissionModeFromFlags, _stripPermFlags, _syncACFAutoPermissions } = await importOnce('./permission_flags.js');
const { _acfServer, _fillModelDatalist, _getAgentModels, _getDefaultModels, _settingsFor } = await importOnce('./launch_models.js');
const { _checkAgentCLI } = await importOnce('./cli_check.js');
const { _classifyLoadedACFModel } = await importOnce('./acf_models.js');
const { modelPickerHtml, loadModelPicker, wireModelPicker, syncModelPicker, thinkingPickerHtml, thinkingValue, setThinking, setThinkingActual, wireThinking } = await importOnce('./model_picker.js');
const { _renderPresetButtons } = await importOnce('./persona_store.js');
const { presetEnforcement, launchedMode } = await importOnce('./preset_enforcement.js');
const { initSectionDialog } = await importOnce('./section_dialog.js');
const { segmentSelect } = await importOnce('./segmented.js');
const { launchFlags } = await importOnce('./launch_flags.js');
import { escapeHtml, escapeAttr } from './utils.js';
import { mountSettingsView } from './settings_view.js'; // the persona page's Behavior prompt is a field of it (a startup module)

// ── Permissions Editor ─────────────────────────────────────────────────
const CAPABILITY_LABELS = {
    file_read: 'Read Files',
    file_write: 'Write Files',
    shell: 'Shell',
    web_access: 'Web Access',
    git_write: 'Git Write',
    agent_spawn: 'Spawn Agents',
    notebook: 'Notebooks',
};
// What a capability does beyond its name, per CLI (#4545, Security's D: for Codex, Git Write is what turns
// off its sandbox).
const CAPABILITY_TITLES = {
    git_write: 'Claude: pre-approves git push, commit, branch, merge and rebase. Codex: Git Write does not change its sandbox; with Shell it can change files in its folder, use the network and never asks.',
};

export function _togglePermissions(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const isHidden = el.style.display === 'none';
    el.style.display = isHidden ? '' : 'none';
    const chevron = el.previousElementSibling?.querySelector('.permissions-chevron');
    if (chevron) chevron.style.transform = isHidden ? 'rotate(90deg)' : '';
}

function _renderPermChips(containerId, type, capabilities) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const caps = capabilities?.[type] || [];
    // Separate base capabilities from shell patterns
    const baseCaps = caps.filter(c => !c.startsWith('shell:'));
    const shellPatterns = caps.filter(c => c.startsWith('shell:')).map(c => c.slice(6));

    let html = '';
    for (const cap of ALL_CAPABILITIES) {
        const isActive = baseCaps.includes(cap);
        const cls = `perm-chip${isActive ? ' active' : ''}`;
        const title = CAPABILITY_TITLES[cap] ? ` title="${escapeAttr(CAPABILITY_TITLES[cap])}"` : '';
        html += `<button type="button" class="${escapeAttr(cls)}" aria-pressed="${escapeAttr(isActive ? 'true' : 'false')}" data-cap="${escapeAttr(cap)}" data-type="${escapeAttr(type)}" data-on-click="perm-chip-toggle" aria-label="${escapeAttr((type === 'deny' ? 'Deny ' : 'Allow ') + (CAPABILITY_LABELS[cap] || cap))}"${title}>${CAPABILITY_LABELS[cap] || cap}</button>`; // the group's own word first: the Allow and the Deny row have a chip each of the same name (#6617)
    }
    container.innerHTML = html;

    // Show shell patterns input if shell is in allow
    const shellSection = container.closest('.permissions-editor')?.querySelector('.perms-shell-patterns');
    const shellInput = container.closest('.permissions-editor')?.querySelector('.perms-shell-input');
    if (shellSection && shellInput && type === 'allow') {
        const hasShell = baseCaps.includes('shell');
        const hasShellPatterns = shellPatterns.length > 0;
        shellSection.style.display = (hasShell || hasShellPatterns) ? '' : 'none';
        shellInput.value = shellPatterns.join(', ');
    }
}

export function _togglePermChip(btn) {
    if (btn.disabled) return;
    btn.classList.toggle('active');
    btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
    // Toggle shell patterns visibility
    const cap = btn.dataset.cap;
    const type = btn.dataset.type;
    if (cap === 'shell' && type === 'allow') {
        const shellSection = btn.closest('.permissions-editor')?.querySelector('.perms-shell-patterns');
        if (shellSection) {
            shellSection.style.display = btn.classList.contains('active') ? '' : 'none';
        }
    }
    _syncEnforcement(btn.closest('[data-acf-uid]'));
}

// The line says what the CLI enforces; an advanced step (the flag that turns Codex's network off) is behind Learn more, named for what it explains, one short line visible (UI/UX's #7492 note).
let _enforcedMoreSeq = 0;
function _renderEnforcedLine(line, e, container) {
    if (!e.more) { line.textContent = e.text; return; }
    const id = `acf-net-more-${container.dataset.acfUid || ''}-${line.dataset.acfEnforcedFor ? 'm' : 'f'}-${++_enforcedMoreSeq}`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'tb-learn acf-learn'; btn.textContent = 'Learn more';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id);
    btn.setAttribute('aria-label', 'Learn more about the network');
    const more = document.createElement('span');
    more.id = id; more.hidden = true;
    const code = document.createElement('code'); code.textContent = e.more;
    more.append(' To turn the network off, add ', code, ' to Flags.');
    btn.addEventListener('click', () => {
        more.hidden = !more.hidden;
        btn.setAttribute('aria-expanded', String(!more.hidden));
        btn.textContent = more.hidden ? 'Learn more' : 'Show less';
        btn.setAttribute('aria-label', more.hidden ? 'Learn more about the network' : 'Show less about the network');
    });
    line.replaceChildren(e.text, ' ', btn, more);
}

// _syncEnforcement says under Permissions what the chosen agent CLI enforces for these permissions
// (#4545, Security's #4550): Codex keeps only a sandbox and an approval mode and Antigravity only a mode, so
// for them a new Deny entry can't be added (an existing one can be removed: it still changes the mode, shown
// in the line) and shell patterns are marked as not enforced. Coral adds no permission layer of its own.
function _syncEnforcement(container) {
    if (!container) return;
    const uid = container.dataset.acfUid;
    const agentType = container.querySelector('.acf-agent-type')?.value || 'claude';
    const permMode = container.querySelector('.acf-permission-mode')?.value
        || defaultPermissionMode(_settingsFor(_acfServer(container)), agentType);
    const caps = _getPermissions(`${uid}-perms`) || {};
    const e = presetEnforcement(agentType, caps, permMode);
    // Codex and Antigravity keep only a sandbox and an approval mode: an explicit Mode is applied and the capabilities may only narrow it; with no Mode the capabilities decide (#6425). Say so beside the Mode.
    const modeSelect = container.querySelector('.acf-permission-mode');
    if (modeSelect) _updatePermModeDescription(modeSelect); // Codex's Auto has its own words
    const override = container.querySelector('.acf-mode-override');
    if (override) {
        const lm = launchedMode(agentType, permMode, caps);
        override.textContent = !lm.narrowed ? '' : permMode === 'default' ? `No Mode chosen, so the capabilities decide: ${lm.text}.` : `The capabilities narrow this Mode: ${lm.text}.`;
        override.hidden = !override.textContent;
    }
    // The form's own line, and any line elsewhere that mirrors it (the Launch dialog shows it under the
    // persona, while this form is folded away).
    const lines = [container.querySelector('.acf-perms-enforced'),
        ...(container.id ? document.querySelectorAll(`[data-acf-enforced-for="${CSS.escape(container.id)}"]`) : [])];
    for (const line of lines) {
        if (!line) continue;
        _renderEnforcedLine(line, e, container);
        line.hidden = !e.text || (e.quiet && line !== container.querySelector('.acf-perms-enforced')); // the plain Bypass line is said once, on Permissions (#5595)
    }
    // Claude in Bypass Permissions mode never asks, so Allow pre-approves nothing: the row is not shown (its
    // chips keep their state, so a saved preset is not changed by looking at it) and the line above says why.
    const allowGroup = container.querySelector(`#${CSS.escape(uid)}-perms-allow`)?.closest('.perms-group');
    const noAllow = _agentFamilyIsClaude(agentType) && permMode === 'bypassPermissions';
    if (allowGroup) allowGroup.hidden = noAllow;
    const patterns = container.querySelector('.perms-shell-patterns'); // the shell patterns are Allow entries: no Allow row, no patterns field (its value is kept)
    if (patterns) patterns.hidden = noAllow;
    for (const chip of container.querySelectorAll(`#${CSS.escape(uid)}-perms-deny .perm-chip`)) {
        chip.disabled = !e.denyEnforced && !chip.classList.contains('active');
    }
    const denyNote = container.querySelector('.perms-deny-note');
    if (denyNote) denyNote.textContent = e.denyEnforced ? '' : 'Not enforced by this agent';
    const patternsNote = container.querySelector('.perms-patterns-note');
    if (patternsNote) patternsNote.textContent = e.patternsEnforced ? '' : 'Not enforced by this agent';
    if (container.querySelector('.acf-tools-details')) { // New Agent's closed disclosure says what is set inside it (#7391)
        const n = type => container.querySelectorAll(`#${CSS.escape(uid)}-perms-${type} .perm-chip.active`).length;
        const sum = container.querySelector('.acf-perms-summary');
        if (sum) sum.textContent = `${n('allow')} allowed, ${n('deny')} denied`;
    }
}

function _agentFamilyIsClaude(agentType) {
    return !agentType || agentType === 'claude';
}

function _getPermissions(editorId) {
    const editor = document.getElementById(editorId);
    if (!editor) return null;

    const result = {};
    for (const type of ['allow', 'deny']) {
        const chips = editor.querySelectorAll(`[data-type="${type}"].active`);
        if (chips.length > 0) {
            result[type] = [...chips].map(c => c.dataset.cap);
        }
    }

    // Add shell patterns to allow list
    const shellInput = editor.querySelector('.perms-shell-input');
    if (shellInput && shellInput.value.trim()) {
        if (!result.allow) result.allow = [];
        const patterns = shellInput.value.split(',').map(p => p.trim()).filter(Boolean);
        for (const p of patterns) {
            result.allow.push(`shell:${p}`);
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

function _setPermissions(editorId, capabilities) {
    const editor = document.getElementById(editorId);
    if (!editor) return;
    _renderPermChips(editorId + '-allow', 'allow', capabilities || {});
    _renderPermChips(editorId + '-deny', 'deny', capabilities || {});
}

// ── Unified Agent Config Form ─────────────────────────────────────────

let _acfCounter = 0;

/**
 * Render a unified agent configuration form into a container.
 * @param {string} containerId - DOM element ID to render into
 * @param {object} opts - { mode: 'full'|'compact-card', showPreset: bool, showName: bool, value: {...} }
 */
/** The form's missing-CLI line: in the form, or where the dialog asked for it (opts.cliSlot). */
export function cliWarningOf(container) { return container._acfCliWarning || container.querySelector('.acf-cli-warning'); }

export function renderAgentConfigForm(containerId, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    _acfCounter++;
    const uid = `acf-${_acfCounter}`;
    container.dataset.acfUid = uid;
    delete container._acfCliWarning;

    const f = acfStartValues(container, opts);
    drawAcfForm(container, uid, opts, f);
    mountAcfPrompts(container, f);
    initAcfPermissions(container, uid, f);
    initAcfPresets(containerId, uid, opts, f);
    initAcfModel(container, f);
    placeAcfCliLine(container, opts);
    wireAcfAgentType(container);
    finishAcfControls(container, opts);
}

/** The Behavior prompt: a field of settings_view (label above; the textarea keeps the class every read of the form uses). */
function mountAcfPrompts(container, { promptVal }) {
    for (const host of container.querySelectorAll('.acf-prompt-host')) {
        const view = mountSettingsView(host, { mode: 'form', fields: [{ key: 'prompt', type: 'textarea', label: 'Behavior prompt', optional: true, rows: Number(host.dataset.rows) || 8, placeholder: "Describe the agent's role and behavior...", setup: e => e.classList.add('acf-prompt') }] });
        view.set('prompt', promptVal);
    }
}

/** What the form starts from: the launch's value (opts.value) over the Settings defaults, and the permissions summary line. */
function acfStartValues(container, opts) {
    const showPreset = opts.showPreset !== false;
    const showName = opts.showName !== false;
    const showAutoPermissions = opts.showAutoPermissions !== false;
    const v = opts.value || {};
    // A form that starts from the Settings defaults says so under those two fields: Settings is where the default lives
    // (UI audit #5589, finding 22), the field here is this launch's own choice.

    const agentTypeVal = v.agentType || v.agent_type || _settingsFor(_acfServer(container)).default_agent_type || '';
    const modelVal = v.model || '';
    const nameVal = v.name || '';
    const promptVal = v.prompt || '';
    const flagsVal = v.flags || '';
    const autoPermsVal = Object.prototype.hasOwnProperty.call(v, 'autoPermissions')
        ? !!v.autoPermissions
        : (Object.prototype.hasOwnProperty.call(v, 'flags') ? _hasPermFlag(flagsVal) : true);

    // Build permissions summary text
    const caps = v.capabilities || null;
    let permsSummary = 'default';
    if (caps) {
        const parts = [];
        if (caps.allow?.length) parts.push(`${caps.allow.length} allow`);
        if (caps.deny?.length) parts.push(`${caps.deny.length} deny`);
        permsSummary = parts.length ? parts.join(', ') : 'default';
    }
    return { showPreset, showName, showAutoPermissions, v, agentTypeVal, modelVal, nameVal, promptVal, flagsVal, autoPermsVal, caps, permsSummary };
}

function acfPresetHtml(uid, opts, { showPreset }) {
    let presetHTML = '';
    if (showPreset) {
        presetHTML = `${opts.sections ? `<div class="launch-field-head"><label for="${escapeAttr(uid)}-preset">Start from a persona</label> <span class="launch-optional">optional</span></div>` : ''}<div id="${escapeAttr(uid)}-presets" class="agent-preset-selector" style="margin-bottom:8px"></div>`;
    }
    return presetHTML;
}

function acfNameHtml(opts, { showName, nameVal }) {
    let nameHTML = '';
    if (showName) {
        nameHTML = `
            <label>${escapeHtml(opts.nameLabel || 'Name / Role')}${opts.nameLabel ? '' : ':'}
                <input type="text" class="acf-name" placeholder="e.g. QA Engineer, Frontend Dev" value="${escapeAttr(nameVal)}">
            </label>`;
    }
    return nameHTML;
}

function acfAutoPermissionsHtml(container, opts, { showAutoPermissions, agentTypeVal, autoPermsVal, flagsVal, v }) {
    let autoPermissionsHTML = '';
    if (showAutoPermissions) {
        const defaultMode = defaultPermissionMode(_settingsFor(_acfServer(container)), agentTypeVal || 'claude');
        const permModeVal = autoPermsVal
            ? (typeof autoPermsVal === 'string' ? autoPermsVal : (_permissionModeFromFlags(flagsVal) || defaultMode))
            : 'default';
        const permModeDesc = v.agentType === 'codex' && CODEX_NETWORK_MODES.includes(permModeVal) ? CODEX_AUTO_DESCRIPTION : PERMISSION_MODE_DESCRIPTIONS[permModeVal] || '';
        autoPermissionsHTML = `
            <label>Permission mode
                <select class="acf-permission-mode" data-on-change="perm-mode-describe">
                    <option value="default"${permModeVal === 'default' ? ' selected' : ''}>Default</option>
                    <option value="plan"${permModeVal === 'plan' ? ' selected' : ''}>Plan</option>
                    <option value="acceptEdits"${permModeVal === 'acceptEdits' ? ' selected' : ''}>Accept edits</option>
                    <option value="auto"${permModeVal === 'auto' ? ' selected' : ''}>Auto</option>
                    <option value="bypassPermissions"${permModeVal === 'bypassPermissions' ? ' selected' : ''}>Bypass permissions</option>
                    <option value="dontAsk"${permModeVal === 'dontAsk' ? ' selected' : ''}>Don't ask</option>
                </select>
                <span class="settings-hint perm-mode-desc">${escapeHtml(permModeDesc)}</span>
                <span class="settings-hint acf-mode-override" role="status" hidden></span>
            </label>`;
    }
    return autoPermissionsHTML;
}

function acfTopHtml(uid, { agentTypeVal, modelVal }) {
    return `
        <div class="acf-top-row">
            <label>Agent Type:
                <select class="acf-agent-type">
                    <option value="claude"${agentTypeVal === 'claude' || !agentTypeVal ? ' selected' : ''}>Claude</option>
                    <option value="codex"${agentTypeVal === 'codex' ? ' selected' : ''}>Codex</option>
                    <option value="agy"${agentTypeVal === 'agy' || agentTypeVal === 'antigravity' || agentTypeVal === 'gemini' ? ' selected' : ''}>Antigravity</option>
                    <option value="pi"${agentTypeVal === 'pi' ? ' selected' : ''}>Pi</option>
                    <option value="terminal"${agentTypeVal === 'terminal' ? ' selected' : ''}>Terminal</option>
                </select>
            </label>
            <label class="acf-model-wrap">Model <span class="launch-optional">optional</span>
                ${modelPickerHtml()}
                <input type="text" class="acf-model" list="acf-models-${uid}" placeholder="Leave blank to use default" autocomplete="off" value="${escapeAttr(modelVal)}">
                <datalist id="acf-models-${escapeAttr(uid)}"></datalist>
            </label>
            ${thinkingPickerHtml()}
        </div>
        <div class="acf-cli-warning" style="display:none;margin:8px 0" role="status"></div>`;
}

function acfPermEditorHtml(uid, open) {
    return `
            <p class="settings-hint acf-perms-enforced" aria-live="polite" hidden></p>
            <div id="${escapeAttr(uid)}-perms" class="permissions-editor"${open ? '' : ' style="display:none"'}>
                <div class="perms-group">
                    <span class="perms-label" id="${escapeAttr(uid)}-perms-allow-label">Allow</span>
                    <div id="${escapeAttr(uid)}-perms-allow" class="perms-chips" role="group" aria-labelledby="${escapeAttr(uid)}-perms-allow-label"></div>
                </div>
                <div class="perms-group">
                    <span class="perms-label" id="${escapeAttr(uid)}-perms-deny-label">Deny <span class="perms-deny-note settings-hint"></span></span>
                    <div id="${escapeAttr(uid)}-perms-deny" class="perms-chips" role="group" aria-labelledby="${escapeAttr(uid)}-perms-deny-label"></div>
                </div>
                <div class="perms-shell-patterns" style="display:none">
                    <label class="perms-label">Shell patterns <span style="color:var(--text-muted);font-weight:var(--fw-regular)">(comma-separated)</span> <span class="perms-patterns-note settings-hint"></span></label>
                    <input type="text" class="field perms-shell-input" aria-label="Shell patterns, comma-separated" placeholder="e.g. git *, npm *, npx *">
                </div>
            </div>`;
}

/** The form's markup, one of the three sectioned layouts or the plain one. */
function drawAcfForm(container, uid, opts, f) {
    const { promptVal, permsSummary, flagsVal } = f;
    const presetHTML = acfPresetHtml(uid, opts, f);
    const nameHTML = acfNameHtml(opts, f);
    const autoPermissionsHTML = acfAutoPermissionsHtml(container, opts, f);
    const topHTML = acfTopHtml(uid, f);
    const permEditorHTML = open => acfPermEditorHtml(uid, open);
    const flagsInput = `<input type="text" class="acf-flags" placeholder="e.g. --verbose" value="${escapeAttr(_stripPermFlags(flagsVal))}">`;
    if (opts.sections) drawSectionedAcf(container, uid, opts, { f, presetHTML, nameHTML, autoPermissionsHTML, topHTML, permEditorHTML, flagsInput });
    else container.innerHTML = `
        ${presetHTML}
        ${nameHTML}
        ${topHTML}
        <label>Behavior Prompt:
            <textarea class="acf-prompt" rows="4" placeholder="Describe the agent's role and behavior...">${escapeHtml(promptVal)}</textarea>
        </label>
        ${autoPermissionsHTML}
        <div class="permissions-section">
            <button type="button" class="permissions-toggle-btn" data-on-click="perms-toggle" data-target="${escapeAttr(uid + '-perms')}">
                <svg class="permissions-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4z"/></svg>
                Permissions <span class="acf-perms-summary" style="color:var(--text-muted);font-weight:var(--fw-regular);font-size:var(--fs-sm)">(${escapeHtml(permsSummary)})</span>
            </button>
            ${permEditorHTML(false)}
        </div>
        <details class="team-advanced acf-flags-details">
            <summary>Flags</summary>
            <div class="team-advanced-body">
                <label>Flags <span class="launch-optional">optional</span>
                    ${flagsInput}
                </label>
            </div>
        </details>
    `;
}

function drawSectionedAcf(container, uid, opts, { f: { showPreset, showName, promptVal }, presetHTML, nameHTML, autoPermissionsHTML, topHTML, permEditorHTML, flagsInput }) {
    // The sectioned dialogs (#4950, section_dialog.js): one pane per group of fields, every field the same element with the same class as in the one-form layout.
    const pane = (id, title, icon, desc, body) => `<section class="settings-pane" data-section="${escapeAttr(id)}" data-title="${escapeAttr(title)}" data-icon="${escapeAttr(icon)}" data-desc="${escapeAttr(desc)}" hidden>${body}</section>`;
    // Whatever the dialog asked to sit in a pane (opts.adopt: { paneId: element id }) is parked beside the container while the panes are rebuilt.
    const adopted = Object.entries(opts.adopt || {}).map(([paneId, id]) => [paneId, document.getElementById(id)]).filter(([, el]) => el);
    for (const [, el] of adopted) container.after(el);
    const adoptedEnd = Object.entries(opts.adoptEnd || {}).map(([paneId, id]) => [paneId, document.getElementById(id)]).filter(([, el]) => el); // parked and placed the same way, but at the END of the pane
    for (const [, el] of adoptedEnd) container.after(el);
    if (opts.wizard) {
        // New Agent's three steps (#7391): step 2 is the persona page (the prompt here, the persona and name adopted above it), step 3 is these three panes: the provider group adopted into Agent, the Mode as cards, the tool chips in a closed disclosure.
        const toolsHTML = `<details class="acf-tools-details"><summary>Tool permissions <span class="acf-perms-summary settings-hint"></span></summary>${permEditorHTML(true)}</details>`;
        container.innerHTML = [
            `<div class="acf-persona-page" data-adopt="persona"><div class="acf-prompt-host" data-rows="8"></div></div>`,
            pane('agent', 'Agent', 'smart_toy', '', topHTML),
            pane('permissions', 'Permissions', 'lock', '', `${autoPermissionsHTML}${toolsHTML}`),
            pane('advanced', 'Advanced', 'tune', '', `<label>Flags <span class="launch-optional">optional</span>${flagsInput}</label>`),
        ].join('');
    } else if (opts.restart) {
        // Restart (#7391): New Agent's steps without the first, the agent being fixed. Step 1 is the persona page (the name, read-only, and the prompt); step 2 is the tabs Model (with Thinking), Permissions, Advanced. The Provider is said in a line; its select stays, hidden, for the form's reads.
        const toolsHTML = `<details class="acf-tools-details"><summary>Tool permissions <span class="acf-perms-summary settings-hint"></span></summary>${permEditorHTML(true)}</details>`;
        const agentHTML = topHTML.replace('<label>Agent Type:', '<label class="acf-provider-label" hidden><span class="acf-provider-head">Provider</span>');
        container.innerHTML = [
            `<div class="acf-persona-page"><p class="launch-field-head"><span>Name</span></p><p class="acf-restart-name"></p><div class="acf-prompt-host" data-rows="8"></div></div>`,
            pane('agent', 'Model', 'smart_toy', '', `<div class="acf-pick-head"><span id="${escapeAttr(uid)}-pick-label">Provider</span></div><div id="${escapeAttr(uid)}-pick" class="launch-agent-pick acf-agent-pick" role="radiogroup" aria-labelledby="${escapeAttr(uid)}-pick-label" hidden></div>${agentHTML}`),
            pane('permissions', 'Permissions', 'lock', '', `${autoPermissionsHTML}${toolsHTML}`),
            pane('advanced', 'Advanced', 'tune', '', `<label>Flags <span class="launch-optional">optional</span>${flagsInput}</label>`),
        ].join('');
    } else {
        // The team member and Add-agent-to-board dialogs (#7391): the same panes as New Agent's step 3, and one Persona pane (the persona, the name, the prompt) where New Agent has a page.
        const toolsHTML = `<details class="acf-tools-details"><summary>Tool permissions <span class="acf-perms-summary settings-hint"></span></summary>${permEditorHTML(true)}</details>`;
        const promptHTML = `<div class="acf-prompt-host" data-rows="10"></div>`;
        container.innerHTML = [
            pane('persona', 'Persona', 'badge', '', `${(showPreset || showName) ? `${presetHTML}${nameHTML}` : ''}${promptHTML}`),
            pane('agent', 'Agent', 'smart_toy', '', topHTML.replace('<label>Agent Type:', '<label class="acf-provider-label"><span class="acf-provider-head">Provider</span>')),
            pane('permissions', 'Permissions', 'lock', '', `${autoPermissionsHTML}${toolsHTML}`),
            pane('advanced', 'Advanced', 'tune', '', `<label>Flags <span class="launch-optional">optional</span>${flagsInput}</label>`),
        ].join('');
        container.dataset.acfPersonaPane = '1';
    }
    for (const [paneId, el] of adopted) container.querySelector(`[data-section="${CSS.escape(paneId)}"], [data-adopt="${CSS.escape(paneId)}"]`)?.prepend(el);
    for (const [paneId, el] of adoptedEnd) container.querySelector(`[data-section="${CSS.escape(paneId)}"], [data-adopt="${CSS.escape(paneId)}"]`)?.append(el);
}

function initAcfPermissions(container, uid, { caps, v }) {
    _setPermissions(`${uid}-perms`, caps);
    setThinking(container, v.thinking); // a form opened for a running agent shows the level it started with (#4969)
    setThinkingActual(container, v.thinking, v.thinkingActual); // and, under it, what the agent last ran at when that differs (#5105)
    _syncEnforcement(container);
    trackPermissionPick(container.querySelector('.acf-permission-mode')); // a mode picked here is the person's, whatever the agent type does next (#5836)
    container.querySelector('.acf-permission-mode')?.addEventListener('change', () => _syncEnforcement(container));
    container.querySelector('.perms-shell-input')?.addEventListener('input', () => _syncEnforcement(container));
}

function initAcfPresets(containerId, uid, opts, { showPreset }) {
    // Render presets if enabled — pass containerId so the preset handler knows which ACF to update
    if (showPreset) {
        _renderPresetButtons(`${uid}-presets`, 'acf', { target: containerId, selectId: opts.sections ? `${uid}-preset` : undefined });
    }
}

function initAcfModel(container, { modelVal, agentTypeVal }) {
    // Loaded values are classified against the provider's known defaults and
    // model catalog. Known values may be replaced on provider switch; custom
    // values remain user-owned. Hold pre-fill until classification completes.
    container.dataset.acfModelDirty = 'false';
    container.dataset.acfModelClassifying = modelVal ? 'true' : 'false';
    if (modelVal) _classifyLoadedACFModel(container, agentTypeVal, modelVal);

    // Any user keystroke / paste / clear marks the field dirty so subsequent
    // agent-type changes won't clobber it. Guard with e.isTrusted so our
    // programmatic assignments (pre-fill, setAgentConfig) don't trip it.
    const modelInput = container.querySelector('.acf-model');
    if (modelInput) {
        modelInput.addEventListener('input', (e) => {
            if (e.isTrusted) {
                container.dataset.acfModelClassifying = 'false';
                container.dataset.acfModelDirty = 'true';
            }
        });
    }
}

function placeAcfCliLine(container, opts) {
    // A dialog that keeps the form's sections behind "More options" can ask for the missing-CLI line to sit outside them (opts.cliSlot, an element id): the first run's
    // most common stop is a CLI that is not installed, and it was found only after pressing Launch (#5835).
    const cliSlot = opts.cliSlot && document.getElementById(opts.cliSlot);
    const cliLine = container.querySelector('.acf-cli-warning');
    if (cliSlot && cliLine) { cliSlot.replaceChildren(cliLine); container._acfCliWarning = cliLine; }
    // Populate datalist + apply visibility + pre-fill for the initial agent type.
    _syncACFModelField(container);
    _checkAgentCLI(container.querySelector('.acf-agent-type')?.value || 'claude', cliWarningOf(container));
}

function wireAcfAgentType(container) {
    container.querySelector('.acf-agent-type')?.addEventListener('change', () => {
        const agentType = container.querySelector('.acf-agent-type')?.value || 'claude';
        _checkAgentCLI(agentType, cliWarningOf(container));
        if (container._acfRestartOrigin) { const f = container.querySelector('.acf-flags'), o = container._acfRestartOrigin; if (f) f.value = (agentType === o.type || (o.alias[agentType] || agentType) === (o.alias[o.type] || o.type)) ? o.flags : ''; } // Restart: another provider's CLI does not take the old one's flags; back on the agent's own (aliases are one provider) they are as they were (#8973, #9003)
        setThinking(container, undefined); // a provider has its own levels: the choice goes back to Default and is not sent (#7391; only a provider resets the Model and Thinking)
        // Still showing the default (nobody picked a mode here): it follows the agent type, Auto for Claude and the other CLIs' own default (#5836)
        syncDefaultPermissionMode(container.querySelector('.acf-permission-mode'), _settingsFor(_acfServer(container)), agentType);
        const permMode = container.querySelector('.acf-permission-mode')?.value || 'default';
        const flagsEl = container.querySelector('.acf-flags');
        if (flagsEl) flagsEl.value = _stripPermFlags(_normalizePermFlagsForAgent(flagsEl.value, agentType, permMode));
        _syncACFAutoPermissions(container);
        _syncACFModelField(container);
        _syncEnforcement(container);
    });
}

function finishAcfControls(container, opts) {
    if (opts.restart) { // Restart's controls (#7391, #8973): the name read-only, and the provider is New Agent's own picker (launch_agent_pick.js): a restart may switch it, keeping the name, role, board and prompt
        const nm = container.querySelector('.acf-restart-name'); if (nm) nm.textContent = opts.restartName || '';
        const typeSel = container.querySelector('.acf-agent-type'), flagsEl = container.querySelector('.acf-flags');
        if (typeSel && flagsEl) container._acfRestartOrigin = { type: typeSel.value, flags: flagsEl.value, alias: { gemini: 'agy', antigravity: 'agy' } }; // the agent's own provider and flags: a switch away clears them, a switch back restores them (#9003)
        const group = container.querySelector('.acf-agent-pick');
        if (group) importOnce('./launch_agent_pick.js').then(m => m.buildAgentPick({ group, form: container, server: _acfServer(container) })).catch(e => console.error('provider picker', e));
    }
    if (opts.sections && !opts.wizard && !opts.restart) segmentSelect(container.querySelector('.acf-agent-type'), { label: 'Provider' }); // the member and board dialogs: the provider as segments, as in Restart (#7407)
    if (opts.wizard || opts.restart || opts.sections) { // the controls drawn over the selects (#7391): the thinking levels as segments, the Mode as cards (or the select, launch_flags.js)
        const thinking = container.querySelector('.acf-thinking');
        if (thinking) segmentSelect(thinking, { labelledby: 'acf-thinking-label' });
        const mode = container.querySelector('.acf-permission-mode');
        if (mode && launchFlags.modeCards) segmentSelect(mode, { label: 'Permission mode', cards: true, className: 'seg-modes' });
        _syncEnforcement(container);
    }
    if (opts.sections) { mountAgentRows(container); mountPermissionRows(container); mountAdvancedRows(container); } // the Agent, Permissions and Advanced panes' rows are fields of settings_view
    if (opts.sections) { const shell = container.closest('.settings-shell'); if (shell) initSectionDialog(shell); } // the panes are in: build the section list
}

/** Move the controls of a built label/wrapper into a field's slot (their listeners and classes come along) and name the selects and inputs by the field's label. */
function adoptChildren(from, keep, slot, labelId) {
    slot.classList.add('acf-agent-slot');
    for (const n of [...from.children]) if (!keep.some(k => n.matches(k))) { slot.append(n); for (const c of [n, ...n.querySelectorAll('select, input:not([type=hidden])')]) if (c.matches && c.matches('select, input') && !c.hasAttribute('aria-label')) c.setAttribute('aria-labelledby', labelId); }
    return {};
}

/** The Permissions pane's rows as fields of settings_view (#8462): the Mode (its select or cards, its sentence and the line that says what an override does) and the tool permissions (the closed disclosure with the chips and the shell patterns) are moved in as they were built. */
function mountPermissionRows(container) {
    const pane = container.querySelector('.settings-pane[data-section="permissions"]');
    if (!pane) return;
    const uid = container.dataset.acfUid || 'acf';
    const modeLabel = pane.querySelector('.acf-permission-mode')?.closest('label');
    const tools = pane.querySelector('.acf-tools-details');
    const fields = [];
    if (modeLabel) fields.push({ key: 'mode', type: 'custom', label: 'Permission mode', labelId: `${uid}-mode-l`, render: slot => adoptChildren(modeLabel, [], slot, `${uid}-mode-l`) });
    if (tools) fields.push({ key: 'tools', type: 'notice', render: slot => slot.append(tools) });
    if (!fields.length) return;
    const host = document.createElement('div'); host.className = 'acf-agent-rows';
    pane.prepend(host);
    mountSettingsView(host, { mode: 'form', fields });
    modeLabel?.remove();
}

/** The Advanced pane's Flags as a field of settings_view (#8462): the form's own input moves in, so the reads and the flag normalising find it as before. */
function mountAdvancedRows(container) {
    const pane = container.querySelector('.settings-pane[data-section="advanced"]');
    const flagsLabel = pane?.querySelector('.acf-flags')?.closest('label');
    if (!flagsLabel) return;
    const uid = container.dataset.acfUid || 'acf';
    const host = document.createElement('div'); host.className = 'acf-agent-rows';
    pane.prepend(host);
    mountSettingsView(host, { mode: 'form', fields: [{ key: 'flags', type: 'custom', label: 'Flags', optional: true, labelId: `${uid}-flags-l`, render: slot => adoptChildren(flagsLabel, ['.launch-optional'], slot, `${uid}-flags-l`) }] });
    flagsLabel.remove();
}

/** The Agent pane's rows as fields of settings_view (#8457): the controls the form built move into them (their listeners and classes come along, so every read of the form is unchanged), and the label, the optional mark and the spacing are the form's. A control the code hides (Model for a terminal, Thinking for a provider with no levels) hides its row. */
function mountAgentRows(container) {
    const pane = container.querySelector('.settings-pane[data-section="agent"]');
    const top = pane && pane.querySelector('.acf-top-row');
    if (!top) return;
    const uid = container.dataset.acfUid || 'acf';
    const provider = top.querySelector('.acf-provider-label:not([hidden])'); // Add/Edit member: the provider as segments (New agent adopts its own provider group; Restart says it in a line)
    const modelWrap = top.querySelector('.acf-model-wrap'), thinkingWrap = top.querySelector('.acf-thinking-wrap');
    const adopt = (from, keep) => (slot, labelId) => adoptChildren(from, keep, slot, labelId);
    const fields = [];
    if (provider) fields.push({ key: 'provider', type: 'custom', label: 'Provider', labelId: `${uid}-provider-l`, render: slot => adopt(provider, ['.acf-provider-head'])(slot, `${uid}-provider-l`) });
    if (modelWrap) fields.push({ key: 'model', type: 'custom', label: 'Model', optional: true, labelId: `${uid}-model-l`, render: slot => adopt(modelWrap, ['.launch-optional'])(slot, `${uid}-model-l`) });
    if (thinkingWrap) { thinkingWrap.querySelector('.acf-thinking-label')?.remove(); fields.push({ key: 'thinking', type: 'custom', label: 'Thinking', optional: true, labelId: 'acf-thinking-label', render: slot => adopt(thinkingWrap, [])(slot, 'acf-thinking-label') }); }
    if (!fields.length) return;
    const host = document.createElement('div'); host.className = 'acf-agent-rows';
    top.before(host);
    const view = mountSettingsView(host, { mode: 'form', fields });
    const follow = (wrap, key) => { // the row is as shown as the control the code shows or hides
        const row = host.querySelector(`.sv-row[data-key="${key}"]`); if (!wrap || !row) return;
        const sync = () => { row.hidden = wrap.hidden || wrap.style.display === 'none'; };
        sync(); new MutationObserver(sync).observe(wrap, { attributes: true, attributeFilter: ['hidden', 'style'] });
    };
    follow(modelWrap, 'model'); follow(thinkingWrap, 'thinking');
    top.classList.add('acf-adopted'); // what is left of the old row (the hidden provider select of New agent, the emptied wrappers the code still finds and toggles) takes no room
    return view;
}


// _syncACFModelField reconciles the Model input with the currently selected
// agent type:
//   • fills the <datalist> with the canonical options for that type,
//   • hides the field entirely for the terminal agent,
//   • pre-fills the input with the user's default for that type, but only
//     when the user hasn't touched the field (dirty flag off).
export function _syncACFModelField(container) {
    if (!container) return;
    const typeSel = container.querySelector('.acf-agent-type');
    const modelWrap = container.querySelector('.acf-model-wrap');
    const modelInput = container.querySelector('.acf-model');
    const datalist = container.querySelector('datalist[id^="acf-models-"]');
    const agentType = typeSel?.value || 'claude';
    if (modelWrap) {
        modelWrap.style.display = (agentType === 'terminal') ? 'none' : '';
    }
    if (datalist) {
        _getAgentModels(_acfServer(container)).then(models => _fillModelDatalist(datalist, agentType, models));
    }
    wireModelPicker(container);
    wireThinking(container);
    loadModelPicker(container, agentType);   // the cached list at once, then the server's (#4066)
    if (!modelInput) return;
    if (container.dataset.acfModelClassifying === 'true' || container.dataset.acfModelDirty === 'true') return; // user owns or we are classifying the value
    if (agentType === 'terminal') {
        modelInput.value = '';
        syncModelPicker(container);
        return;
    }
    _getDefaultModels(_acfServer(container)).then(defaults => {
        // If the user started typing during the fetch, don't clobber their input.
        if (container.dataset.acfModelDirty === 'true' || container.dataset.acfModelClassifying === 'true') return;
        // Re-check the agent type — the user may have switched again mid-fetch.
        const currentType = typeSel?.value || 'claude';
        if (currentType === 'terminal') {
            modelInput.value = '';
            syncModelPicker(container);
            return;
        }
        modelInput.value = defaults[currentType] || '';
        syncModelPicker(container);
        container.dispatchEvent(new Event('acf-synced', { bubbles: true })); // a summary of the form (New Agent's rows) follows the default arriving
    });
}
window.renderAgentConfigForm = renderAgentConfigForm;

/**
 * Get current values from an AgentConfigForm.
 * @param {string} containerId - The container ID
 * @returns {object} { name, agentType, model, prompt, flags, capabilities }
 */
export function getAgentConfig(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    const uid = container.dataset.acfUid;
    const agentType = container.querySelector('.acf-agent-type')?.value || 'claude';
    const permMode = container.querySelector('.acf-permission-mode')?.value || 'default';
    let flags = _stripPermFlags(container.querySelector('.acf-flags')?.value.trim() || '');
    if (permMode && permMode !== 'default') {
        flags = _normalizePermFlagsForAgent(flags, agentType, permMode);
    }

    // Terminal agents never carry a model — the field is hidden in the UI.
    const rawModel = container.querySelector('.acf-model')?.value.trim() || '';
    const model = agentType === 'terminal' ? '' : rawModel;

    return {
        name: container.querySelector('.acf-name')?.value.trim() || '',
        agentType,
        model,
        thinking: agentType === 'terminal' ? undefined : thinkingValue(container), // undefined: not chosen, so a launch uses the default and a restart keeps the agent's level (#4969)
        prompt: container.querySelector('.acf-prompt')?.value.trim() || '',
        flags,
        permissionMode: permMode, // what the form's select says: a launch on Default asks nothing about skipping prompts (#7620)
        capabilities: uid ? _getPermissions(`${uid}-perms`) : null,
    };
}
window.getAgentConfig = getAgentConfig;

/**
 * Set/pre-fill values in an AgentConfigForm.
 * @param {string} containerId - The container ID
 * @param {object} values - { name, agentType, model, prompt, flags, capabilities }
 */
export function setAgentConfig(containerId, values) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const uid = container.dataset.acfUid;
    const v = values || {};

    const nameEl = container.querySelector('.acf-name');
    if (nameEl) nameEl.value = v.name || '';
    const typeEl = container.querySelector('.acf-agent-type');
    if (typeEl) typeEl.value = v.agentType || v.agent_type || _settingsFor(_acfServer(container)).default_agent_type || 'claude';
    const modelEl = container.querySelector('.acf-model');
    if (modelEl) {
        modelEl.value = v.model || '';
        syncModelPicker(container);
        container.dataset.acfModelClassifying = v.model ? 'true' : 'false';
        container.dataset.acfModelDirty = 'false';
        if (v.model) _classifyLoadedACFModel(container, typeEl?.value || 'claude', v.model);
    }
    setThinking(container, v.thinking);
    setThinkingActual(container, v.thinking, v.thinkingActual);
    const promptEl = container.querySelector('.acf-prompt');
    if (promptEl) promptEl.value = v.prompt || '';
    const flagsEl = container.querySelector('.acf-flags');
    if (flagsEl) flagsEl.value = _stripPermFlags(v.flags || '');
    const permModeEl = container.querySelector('.acf-permission-mode');
    if (permModeEl) {
        // Extract permission mode from flags if present, otherwise use default from settings
        const flagMode = _permissionModeFromFlags(v.flags || '');
        const defaultMode = defaultPermissionMode(_settingsFor(_acfServer(container)), typeEl?.value || 'claude');
        if (flagMode) {
            permModeEl.value = flagMode;
            permModeEl.dataset.pickedByPerson = '1'; // a saved configuration's mode is a choice
        } else if (_hasPermFlag(v.flags || '')) {
            // Legacy --dangerously-skip-permissions flag → map to bypassPermissions
            permModeEl.value = 'bypassPermissions';
            permModeEl.dataset.pickedByPerson = '1';
        } else if (Object.prototype.hasOwnProperty.call(v, 'flags')) {
            permModeEl.value = 'default';
            permModeEl.dataset.pickedByPerson = '1';
        } else {
            permModeEl.value = defaultMode;
        }
    }

    if (uid) _setPermissions(`${uid}-perms`, v.capabilities || null);
    _syncEnforcement(container);

    // Re-sync Model combo and prerequisite warning after a preset/type change.
    _syncACFModelField(container);
    _checkAgentCLI(typeEl?.value || 'claude', cliWarningOf(container));
}
(window.__coral ||= {}).setAgentConfig = setAgentConfig;


/** Give a form another provider the way a person's choice does (#7407, Set all workers to): its Model and Thinking go back to their defaults (the provider's own), its Mode, name and prompt stay. */
export function resetProviderChoices(containerId, type) {
    const container = document.getElementById(containerId);
    const sel = container?.querySelector('.acf-agent-type');
    if (!sel) return;
    const modeEl = container.querySelector('.acf-permission-mode');
    const mode = modeEl?.value, picked = modeEl?.dataset.pickedByPerson;
    sel.value = type;
    sel.dispatchEvent(new Event('change', { bubbles: true })); // the form's own handler: CLI check, the Mode's flags for the provider, Thinking back to Default
    if (modeEl && mode && [...modeEl.options].some(o => o.value === mode)) { // the Mode stays what it was: the provider's default Mode is for a person's own change of provider
        modeEl.value = mode;
        if (picked) modeEl.dataset.pickedByPerson = picked; else delete modeEl.dataset.pickedByPerson;
        modeEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const model = container.querySelector('.acf-model');
    if (model) { model.value = ''; container.dataset.acfModelDirty = 'false'; container.dataset.acfModelClassifying = 'false'; syncModelPicker(container); }
    _syncACFModelField(container);
    setThinking(container, undefined);
}
