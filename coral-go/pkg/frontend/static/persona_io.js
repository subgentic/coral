/* Moved out of modals.js as it was (#4684): Saving the launch form as a persona, exporting and importing personas and team templates as JSON files, and the agent preset selector of the single-agent dialog. No behaviour change. */
import { importOnce } from './import_once.js';
import { showToast } from './utils.js';
const { launch } = await importOnce('./launch_state.js');
const { _effectiveServer, _settingsFor } = await importOnce('./launch_models.js');
const { AGENT_PRESETS } = await importOnce('./agent_presets.js');
const { _findPersona, _getSavedPersonas, _getSavedTeamTemplates, _renderPresetButtons, _upsertSavedPersonas, _upsertSavedTeamTemplates } = await importOnce('./persona_store.js');
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
}
window._saveCurrentPersona = _saveCurrentPersona;

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

/** The most an imported personas or templates file may be: a person's own list is kilobytes; a file this size is not one (#10510). */
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_TEMPLATES = 200;
/** What is wrong with a file about to be read for import, in words, or ''. */
export function importFileProblem(file) {
    return file && file.size > MAX_IMPORT_BYTES ? `That file is too large to be imported (over ${MAX_IMPORT_BYTES / (1024 * 1024)} MB): a personas or template file is far smaller.` : '';
}

function _openFilePicker() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = () => {
            const file = input.files[0];
            if (!file) { resolve(null); return; }
            const tooBig = importFileProblem(file);
            if (tooBig) { showToast(tooBig, "error"); resolve(null); return; }
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

/** What is wrong with a team template file, in words, or the templates it holds (#10366). A template file is the .json that Export this template (or Share team) makes: {"type": "coral-team-templates", "templates": [{name, agents: [...]}]}. */
export function readTeamTemplateFile(data) {
    const FORMAT = 'a Coral team template: a .json file made by Export this template ({"type": "coral-team-templates", "templates": [...]})';
    if (data === null || typeof data !== 'object') return { entries: [], problems: [`That file is not ${FORMAT}.`] };
    if (!Array.isArray(data) && data.type !== undefined && data.type !== 'coral-team-templates') {
        return { entries: [], problems: [`That file is ${data.type === 'coral-personas' ? 'a personas file' : `a "${String(data.type).slice(0, 40)}" file`}, not ${FORMAT}.`] };
    }
    const templates = Array.isArray(data) ? data : data.templates;
    if (!Array.isArray(templates)) return { entries: [], problems: [`That file has no "templates" list: it is not ${FORMAT}.`] };
    if (!templates.length) return { entries: [], problems: ['That file holds no templates.'] };
    if (templates.length > MAX_IMPORT_TEMPLATES) return { entries: [], problems: [`That file holds ${templates.length} templates: Coral imports at most ${MAX_IMPORT_TEMPLATES} at once.`] };
    const entries = [], problems = [];
    templates.forEach((t, i) => {
        const named = t && typeof t.name === 'string' && t.name.trim() ? `"${t.name.trim().slice(0, 60)}"` : '';
        if (!t || typeof t !== 'object') problems.push(`Template ${i + 1} is not a template.`);
        else if (!named) problems.push(`Template ${i + 1} has no name.`);
        else if (!Array.isArray(t.agents) || !t.agents.length) problems.push(`${named} has no members.`);
        else if (t.agents.some(a => !a || typeof a.name !== 'string' || !a.name.trim())) problems.push(`A member of ${named} has no name.`);
        else entries.push(t);
    });
    return { entries, problems };
}

export async function importTeamTemplates() {
    const data = await _openFilePicker();
    if (!data) return;
    await applyTeamTemplateFile(data);
}

/** Do the import of a read template file: what it saves, what it skips, and, once, a warning when a template carries flags (they are run as given when the team launches). */
export async function applyTeamTemplateFile(data) {
    const { entries, problems } = readTeamTemplateFile(data);
    if (!entries.length) { showToast(problems[0], "error"); return; }
    try { await _upsertSavedTeamTemplates(entries); } catch { showToast("Could not save the imported templates", "error"); return; }
    showToast(problems.length ? `Imported ${entries.length} template(s); skipped ${problems.length}: ${problems[0]}` : `Imported ${entries.length} template(s)`);
    if (entries.some(t => String(t.flags || '').trim() || (t.agents || []).some(a => String(a.flags || '').trim()))) {
        showToast("This template sets command-line flags. Check them before you launch: they are run as given.", "error"); // one warning for the whole file, from a file someone else may have made
    }
    _renderTeamTemplateSelector();
}

/** Export the saved template `name` as a .json file: its members (roles, instructions, models, flags) and the team's flags, the file Import a template takes (#10366). */
export function exportTeamTemplate(name) {
    const t = _getSavedTeamTemplates().find(x => x.name === name);
    if (!t) { showToast("Pick one of your saved templates to export it", "error"); return; }
    _downloadJson({ version: 1, type: "coral-team-templates", templates: [t] }, `coral-team-template-${String(t.name).replace(/[^a-zA-Z0-9-_]/g, "_")}.json`);
    showToast(`Exported the template "${t.name}". Its instructions and flags are in the file: do not share it if they hold keys or other secrets.`);
}

// ── Agent Preset Selector (single-agent modal) ───────────────────────────

function _initAgentPresets() {
    _renderPresetButtons("agent-preset-selector", "agent", { blankFirst: true, selectId: 'launch-persona-select' });
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
