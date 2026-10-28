/* Moved out of modals.js as it was (#4684): Saving the launch form as a persona, exporting and importing personas and team templates as JSON files, and the agent preset selector of the single-agent dialog. No behaviour change. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer, _settingsFor } = await importOnce('./launch_models.js');
const { AGENT_PRESETS } = await importOnce('./agent_presets.js');
const { _findPersona, _getSavedPersonas, _getSavedTeamTemplates, _renderPresetButtons, _upsertSavedPersonas, _upsertSavedTeamTemplates, _renameSavedPersona, _deleteSavedPersona } = await importOnce('./persona_store.js');
const { getAgentConfig, setAgentConfig } = await importOnce('./agent_config_form.js');
const { _renderTeamTemplateSelector } = await importOnce('./team_dialogs.js');

async function _saveCurrentPersona(nameInputId, promptInputId, flagsInputId) {
    let name, prompt, flags, capabilities;
    if (nameInputId) {
        // Legacy path with explicit element IDs
        name = document.getElementById(nameInputId)?.value.trim() || '';
        prompt = document.getElementById(promptInputId)?.value.trim() || '';
        flags = flagsInputId ? document.getElementById(flagsInputId)?.value.trim() || '' : '';
        capabilities = null;
    } else {
        // ACF path — read from the launch agent config form
        const config = getAgentConfig('launch-agent-acf');
        name = document.getElementById("launch-agent-name-input")?.value.trim() || config.name;
        prompt = config.prompt;
        flags = config.flags;
        capabilities = config.capabilities;
    }
    if (!name) { showToast("Enter a name before saving", "error"); return; }
    if (AGENT_PRESETS.find(p => p.name === name)) { showToast("Can't overwrite a built-in preset", "error"); return; }

    const entry = { name, prompt, flags };
    if (capabilities) entry.capabilities = capabilities;
    try { await _upsertSavedPersonas([entry]); } catch { showToast("Could not save the persona", "error"); return; }
    showToast(`Saved persona "${name}"`);

    // Re-render all preset containers
    _renderPresetButtons("agent-preset-selector", "agent", { blankFirst: true, selectId: 'launch-persona-select' });
    _syncPersonaButtons();
}
window._saveCurrentPersona = _saveCurrentPersona;

// ── Rename and delete a saved persona (#10285): the one picked in New agent's step 2; a built-in or Blank has neither ──
const selectedSavedPersona = () => {
    const name = document.getElementById('launch-persona-select')?.value || '';
    return name && name !== '__blank__' && _getSavedPersonas().some(p => p && p.name === name) ? name : '';
};
/** Rename and Delete are on for a saved persona and off, with the reason as their title, otherwise. */
function _syncPersonaButtons() {
    const picked = selectedSavedPersona();
    for (const id of ['agent-rename-persona-btn', 'agent-delete-persona-btn']) {
        const b = document.getElementById(id);
        if (!b) continue;
        b.disabled = !picked;
        b.title = picked ? (id === 'agent-rename-persona-btn' ? `Rename "${picked}"` : `Delete "${picked}"`) : 'Pick one of your saved personas first (a built-in persona has neither)';
    }
}
function _afterPersonaChange(pick) {
    _renderPresetButtons("agent-preset-selector", "agent", { blankFirst: true, selectId: 'launch-persona-select' });
    const sel = document.getElementById('launch-persona-select');
    if (sel) sel.value = pick && [...sel.options].some(o => o.value === pick) ? pick : '__blank__';
    _syncPersonaButtons();
}
async function _renamePersona() {
    const old = selectedSavedPersona();
    if (!old) { showToast('Pick one of your saved personas first', 'error'); return; }
    window.showPromptModal('Rename persona', 'Persona name', old, async name => {
        const next = String(name || '').trim();
        if (next === old) return;
        if (AGENT_PRESETS.some(p => p.name === next) || _getSavedPersonas().some(p => p && p.name === next)) { showToast(`There is already a persona called "${next}"`, 'error'); return; }
        try { await _renameSavedPersona(old, next); } catch { showToast('Could not rename the persona', 'error'); return; }
        showToast(`Renamed to "${next}"`);
        _afterPersonaChange(next);
    });
}
function _deletePersona() {
    const name = selectedSavedPersona();
    if (!name) { showToast('Pick one of your saved personas first', 'error'); return; }
    window.showConfirmModal('Delete persona', `Delete the saved persona "${name}"? Agents already started from it are not changed.`, async () => {
        try { await _deleteSavedPersona(name); } catch { showToast('Could not delete the persona', 'error'); return; }
        showToast(`Deleted persona "${name}"`);
        _afterPersonaChange('');
    }, undefined, { label: 'Delete persona', danger: true });
}
window._renamePersona = _renamePersona;
window._deletePersona = _deletePersona;
document.addEventListener('change', e => { if (e.target && e.target.id === 'launch-persona-select') _syncPersonaButtons(); });

// ── Export / Import (Personas & Team Templates) ──────────────────────────

function _downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function _openFilePicker() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = () => {
            const file = input.files[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = () => {
                try { resolve(JSON.parse(reader.result)); }
                catch { showToast("Invalid JSON file", "error"); resolve(null); }
            };
            reader.readAsText(file);
        };
        input.click();
    });
}

export function exportPersonas() {
    const saved = _getSavedPersonas();
    if (saved.length === 0) { showToast("No saved personas to export", "error"); return; }
    _downloadJson({ version: 1, type: "coral-personas", personas: saved }, "coral-personas.json");
    showToast(`Exported ${saved.length} persona(s)`);
}

export async function importPersonas() {
    const data = await _openFilePicker();
    if (!data) return;
    const personas = data.personas || (Array.isArray(data) ? data : null);
    if (!personas || !Array.isArray(personas)) { showToast("Invalid persona file format", "error"); return; }

    const entries = [];
    for (const p of personas) {
        if (!p.name) continue;
        if (AGENT_PRESETS.find(bp => bp.name === p.name)) continue;
        entries.push({ name: p.name, prompt: p.prompt || "", flags: p.flags || "" });
    }
    const added = entries.length;
    try { await _upsertSavedPersonas(entries); } catch { showToast("Could not save the imported personas", "error"); return; }
    showToast(`Imported ${added} persona(s)`);
    _renderPresetButtons("agent-preset-selector", "agent", { blankFirst: true, selectId: 'launch-persona-select' });
}

export function exportTeamTemplates() {
    const templates = _getSavedTeamTemplates();
    if (templates.length === 0) { showToast("No saved templates to export", "error"); return; }
    _downloadJson({ version: 1, type: "coral-team-templates", templates }, "coral-team-templates.json");
    showToast(`Exported ${templates.length} template(s)`);
}

export async function importTeamTemplates() {
    const data = await _openFilePicker();
    if (!data) return;
    const templates = data.templates || (Array.isArray(data) ? data : null);
    if (!templates || !Array.isArray(templates)) { showToast("Invalid template file format", "error"); return; }

    const entries = templates.filter(t => t.name && Array.isArray(t.agents));
    const added = entries.length;
    try { await _upsertSavedTeamTemplates(entries); } catch { showToast("Could not save the imported templates", "error"); return; }
    showToast(`Imported ${added} template(s)`);
    _renderTeamTemplateSelector();
}

// ── Agent Preset Selector (single-agent modal) ───────────────────────────

function _initAgentPresets() {
    _renderPresetButtons("agent-preset-selector", "agent", { blankFirst: true, selectId: 'launch-persona-select' });
    _syncPersonaButtons();
}

function _selectAgentPreset(name) {
    const persona = name ? _findPersona(name) : null;
    const nameInput = document.getElementById("launch-agent-name-input");
    const current = getAgentConfig('launch-agent-acf');
    if (persona) {
        setAgentConfig('launch-agent-acf', {
            name: persona.name,
            prompt: persona.prompt,
            flags: persona.flags || current.flags,
            agentType: persona.agentType || persona.agent_type || current.agentType,
            model: persona.model || current.model,
            capabilities: persona.capabilities,
        });
        if (nameInput) nameInput.value = persona.name;
        _nameHelp(true);
    } else {
        setAgentConfig('launch-agent-acf', {
            agentType: _settingsFor(_effectiveServer(launch.server)).default_agent_type || current.agentType,
        });
        if (nameInput) nameInput.value = '';
        _nameHelp(false);
    }
}

// The line under Name says where the name came from: one line either way, so nothing on the page moves (#7391).
function _nameHelp(filled) {
    const el = document.querySelector('.launch-name-help');
    if (el) el.textContent = filled ? 'Filled from the persona. Change it if you want a different name.' : 'Choose a persona above and its name goes here, or type your own.';
}

export { _initAgentPresets, _selectAgentPreset };
