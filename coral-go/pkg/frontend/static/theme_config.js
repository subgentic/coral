/* Theme configurator — custom color theme editor with save/load/import/export */

import { runFailure } from './run_failure.js';
import { state } from './state.js';
import { escapeHtml, escapeAttr, showToast } from './utils.js';
import { registerActions } from './actions.js';
import { updateTerminalTheme } from './xterm_renderer.js';
import { isCloud } from './server_base.js';
import { applyTheme, applyThemeData, clearCustomThemeVars } from './settings_core.js';
import { browserLocal } from './safe_storage.js';

let variableGroups = {};   // { groupName: { cssVar: label, ... }, ... }
let currentEdits = {};     // { cssVar: colorValue, ... }
let pageBefore = null;      // { theme, style }: the page's own base and colours when the configurator opened, for Cancel to put back (a Preview changes the page itself, #12307)
let savedThemes = [];      // [{ name, description, base }, ...]
let activeName = '';       // the select's current value: the saved theme in use ('' = the page's own base, shown as Dark or Light)
let lastBase = 'dark';     // the base the editor's colours were last taken from (the Based on list; the page's own base when the dialog opens)

const pageBase = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

/** What every variable of the editor is under a base theme (dark or light), read from the page itself: the base is put on the page for a moment with no custom colours over it, then the page is put back as it was. */
function baseValues(base) {
    const root = document.documentElement, was = root.getAttribute('data-theme'), saved = {};
    const names = Object.values(variableGroups).flatMap(vars => Object.keys(vars));
    for (const cssVar of names) { saved[cssVar] = root.style.getPropertyValue(cssVar); root.style.removeProperty(cssVar); }
    root.setAttribute('data-theme', base);
    const out = {}, styles = getComputedStyle(root);
    for (const cssVar of names) out[cssVar] = styles.getPropertyValue(cssVar).trim();
    if (was == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', was);
    for (const [cssVar, v] of Object.entries(saved)) if (v) root.style.setProperty(cssVar, v);
    return out;
}

export async function showThemeConfigurator() {
    // Load variable definitions and saved themes in parallel
    const [varsResp, themesResp] = await Promise.all([
        fetch('/api/themes/variables').then(r => r.json()),
        fetch('/api/themes').then(r => r.json()),
    ]);
    variableGroups = varsResp.groups || {};
    savedThemes = themesResp.themes || [];

    // Seed currentEdits from the current computed CSS values
    currentEdits = {};
    const styles = getComputedStyle(document.documentElement);
    for (const vars of Object.values(variableGroups)) {
        for (const cssVar of Object.keys(vars)) {
            const val = styles.getPropertyValue(cssVar).trim();
            currentEdits[cssVar] = val;
        }
    }

    pageBefore = { theme: document.documentElement.getAttribute('data-theme'), style: document.documentElement.getAttribute('style') };
    activeName = (state.settings && state.settings.custom_theme) || '';
    renderModal();
    lastBase = pageBase();
    document.getElementById('theme-save-base').value = lastBase; // a light page starts on Light: a theme saved from it is a light one
    if (activeName) document.getElementById('theme-save-name').value = activeName; // the theme in use is the one Save would update
    syncSaveHint();
    const modal = document.getElementById('theme-configurator-modal');
    if (!modal._previewGuard) { // however it closes (Cancel, Escape, a backdrop click: the page-wide rules hide it with display:none), a preview that was not saved is undone
        modal._previewGuard = new MutationObserver(() => { if (modal.style.display === 'none' && pageBefore) hideThemeConfigurator(); });
        modal._previewGuard.observe(modal, { attributes: true, attributeFilter: ['style'] });
    }
    modal.style.display = 'flex';
}

/** Close the configurator. Unless the theme was saved (keep), the page goes back to the base and colours it had when the configurator opened: a Preview or a Load had changed the page itself. */
export function hideThemeConfigurator({ keep = false } = {}) {
    if (!keep && pageBefore) {
        const root = document.documentElement;
        if (pageBefore.theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pageBefore.theme);
        if (pageBefore.style === null) root.removeAttribute('style'); else root.setAttribute('style', pageBefore.style);
        updateTerminalTheme();
    }
    pageBefore = null;
    document.getElementById('theme-configurator-modal').style.display = 'none';
}

function renderModal() {
    const modal = document.getElementById('theme-configurator-modal');
    if (!modal) return;

    const inUse = activeName || `base:${pageBase()}`; // the theme the page is using is the one the list shows; with none saved it is the one named like the page's base (Dark, Light)
    const isUse = name => name === inUse || (!activeName && String(name).toLowerCase() === pageBase());
    const themeOptions = savedThemes.map(t =>
        `<option value="${escapeAttr(t.name)}"${isUse(t.name) ? ' selected' : ''}>${escapeHtml(t.name)}</option>`
    ).join('');

    const has = n => savedThemes.some(t => String(t.name).toLowerCase() === n); // Dark and Light are bases of their own; a theme the server lists by that name is shown once, as it is
    const builtIn = ['dark', 'light'].filter(b => !has(b)).map(b => `<option value="${escapeAttr('base:' + b)}"${'base:' + b === inUse ? ' selected' : ''}>${b === 'light' ? 'Light' : 'Dark'}</option>`).join('');
    const groups = Object.entries(variableGroups).map(([groupName, vars]) => {
        const rows = Object.entries(vars).map(([cssVar, label]) => {
            const value = currentEdits[cssVar] || '';
            const hexValue = toHex(value);
            return `<div class="theme-row">
                <label class="theme-label" title="${escapeHtml(cssVar)}">${escapeHtml(label)}</label>
                <div class="theme-color-wrap">
                    <input type="color" class="theme-color-picker" value="${escapeAttr(hexValue)}" data-var="${escapeAttr(cssVar)}"
                        data-on-input="theme-var">
                    <input type="text" class="theme-color-text" value="${escapeHtml(value)}" placeholder="default" data-var="${escapeAttr(cssVar)}"
                        data-on-input="theme-var-text">
                </div>
            </div>`;
        }).join('');
        return `<div class="theme-group">
            <div class="theme-group-title">${escapeHtml(groupName)}</div>
            ${rows}
        </div>`;
    }).join('');

    modal.innerHTML = `
        <div class="modal-content dlg-form theme-configurator-content">
            <h3>Customize theme</h3>
            <div class="toolbar toolbar-pad-bare theme-toolbar">
                <select id="theme-load-select" class="settings-select">
                    <option value="">Load theme...</option>
                    ${builtIn}
                    ${themeOptions}
                </select>
                <button class="btn" data-on-click="theme-load">Load</button>
                <button class="btn btn-danger" data-on-click="theme-delete">Delete</button>
                <span class="toolbar-spacer"></span>
                ${isCloud() ? '' : '<button class="btn" data-on-click="theme-import">Import</button>'}
                <button class="btn" data-on-click="theme-export">Export</button>
            </div>
            ${isCloud() ? '' : `<div class="toolbar toolbar-stretch toolbar-nowrap toolbar-pad-bare theme-generate-bar">
                <input type="text" id="theme-ai-prompt" class="settings-input" placeholder="Describe your theme... (e.g. &quot;cyberpunk neon with pink and teal&quot;)">
                <button class="btn btn-primary" id="theme-generate-btn" data-on-click="theme-generate">Generate</button>
            </div>`}
            <div class="theme-editor-scroll">
                ${groups}
            </div>
            <div class="toolbar toolbar-stretch toolbar-pad-bare theme-save-bar">
                <input type="text" id="theme-save-name" class="settings-input" placeholder="Theme name" data-on-input="theme-name-input">
                <input type="text" id="theme-save-desc" class="settings-input" placeholder="Description (optional)">
                <select id="theme-save-base" class="settings-select form-control-auto" data-on-change="theme-base-change">
                    <option value="dark">Based on: Dark</option>
                    <option value="light">Based on: Light</option>
                </select>
            </div>
            <p class="settings-hint theme-save-hint" id="theme-save-hint" role="status"></p>
            <div class="modal-actions">
                <button class="btn" data-on-click="theme-close">Cancel</button>
                <button class="btn" data-on-click="theme-reset">Reset</button>
                <button class="btn" data-on-click="theme-preview">Preview</button>
                <button class="btn btn-primary" data-on-click="theme-save">Save and apply</button>
            </div>
        </div>
    `;
}

// ── Color picker handlers (exposed globally) ────────────────────────────

(window.__coral ||= {}).updateThemeVar = function(picker) {
    const cssVar = picker.dataset.var;
    const value = picker.value;
    currentEdits[cssVar] = value;
    // Sync the text input
    const textInput = picker.parentElement.querySelector('.theme-color-text');
    if (textInput) textInput.value = value;
};

(window.__coral ||= {}).updateThemeVarText = function(input) {
    const cssVar = input.dataset.var;
    const value = input.value.trim();
    currentEdits[cssVar] = value;
    // Sync the color picker if it's a valid hex
    const hex = toHex(value);
    if (hex !== '#000000' || value.toLowerCase().startsWith('#000')) {
        const picker = input.parentElement.querySelector('.theme-color-picker');
        if (picker) picker.value = hex;
    }
};

// ── Theme operations ─────────────────────────────────────────────────────

(window.__coral ||= {}).previewTheme = function() {
    document.documentElement.setAttribute('data-theme', document.getElementById('theme-save-base')?.value === 'light' ? 'light' : 'dark'); // the base the theme is based on, as a saved theme applies it at start
    applyVariablesToDom(currentEdits);
    showToast('Theme preview applied');
};

function resetThemeToDefaults() {
    // Remove all custom properties and reload
    for (const cssVar of Object.keys(currentEdits)) {
        document.documentElement.style.removeProperty(cssVar);
    }
    // Re-read computed values
    const styles = getComputedStyle(document.documentElement);
    for (const cssVar of Object.keys(currentEdits)) {
        currentEdits[cssVar] = styles.getPropertyValue(cssVar).trim();
    }
    renderModal();
    showToast('Reset to defaults');
};

(window.__coral ||= {}).saveAndApplyTheme = async function() {
    const name = document.getElementById('theme-save-name').value.trim();
    if (!name) {
        showToast('Theme name is required', true);
        return;
    }
    const description = document.getElementById('theme-save-desc').value.trim();
    const base = document.getElementById('theme-save-base').value;

    try {
        const resp = await fetch(`/api/themes/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description, base, variables: currentEdits }),
        });
        const data = await resp.json();
        if (data.error) {
            if (!isCloud()) showToast(data.error, true); // on the hub the fetch wrapper already explained the refusal
            return;
        }

        // Save the active theme name in settings
        await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_theme: name }),
        });
        state.settings.custom_theme = name; activeName = name;

        document.documentElement.setAttribute('data-theme', base === 'light' ? 'light' : 'dark');
        applyVariablesToDom(currentEdits);
        showToast(`Theme "${name}" saved and applied`);
        hideThemeConfigurator({ keep: true });
    } catch (e) {
        showToast('Failed to save theme', true);
    }
};

/** What Save and apply will do, in words: update the saved theme of that name, or make a new one (#13760). */
function syncSaveHint() {
    const hint = document.getElementById('theme-save-hint'), name = document.getElementById('theme-save-name')?.value.trim();
    if (!hint) return;
    if (!name) { hint.textContent = 'Name it to save it as a new theme. A theme you loaded is already in use.'; return; }
    const exact = savedThemes.find(t => t.name === name);
    const other = savedThemes.find(t => String(t.name).toLowerCase() === name.toLowerCase());
    hint.textContent = exact ? `Save and apply updates "${exact.name}". Change the name to make a new copy.` : other ? `"${other.name}" is a saved theme with another capitalisation: saving makes a new theme.` : `Save and apply makes a new theme, "${name}".`;
}

/** The page as it is now is the page Cancel returns to: a loaded theme is in use, not a preview. */
function commitPage() {
    pageBefore = { theme: document.documentElement.getAttribute('data-theme'), style: document.documentElement.getAttribute('style') };
}

/** Make a theme the one in use: on the page, and as the saved setting (a reload keeps it). `theme` is the one already read ({ base, variables }), applied as it is: nothing is fetched twice. No theme (name '') puts the
 *  built-in base on the page, with no saved theme. Resolves true when it was kept; when it was not (the theme is no theme, or the settings did not save) the page and the remembered preference go back as they were. */
async function useTheme(name, theme, base) {
    const root = document.documentElement, before = { theme: root.getAttribute('data-theme'), style: root.getAttribute('style') };
    let pref = null; try { pref = browserLocal.get('coral-theme'); } catch { /* none */ }
    const back = () => {
        if (before.theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', before.theme);
        if (before.style === null) root.removeAttribute('style'); else root.setAttribute('style', before.style);
        try { if (pref == null) browserLocal.remove('coral-theme'); else browserLocal.set('coral-theme', pref); } catch { /* none */ }
        updateTerminalTheme();
    };
    clearCustomThemeVars();
    if (name) { if (!applyThemeData(theme)) { back(); showToast('Could not use that theme: it has no colours', true); return false; } } else applyTheme(base);
    try {
        const body = name ? { custom_theme: name } : { theme: base, custom_theme: '' };
        const resp = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!resp.ok) throw new Error('settings');
        Object.assign(state.settings, body);
        activeName = name; commitPage();
        return true;
    } catch {
        back();
        showToast('Could not use that theme: it was not saved as your theme', true);
        return false;
    }
}

async function loadSelectedTheme() {
    const select = document.getElementById('theme-load-select');
    const name = select.value;
    if (!name) return;
    const showInUse = () => { select.value = [...select.options].find(o => o.defaultSelected)?.value ?? ''; }; // a Load that was not kept: the list goes back to the theme in use
    if (name.startsWith('base:')) { // Dark or Light itself: every colour is the base's
        const base = name.slice(5) === 'light' ? 'light' : 'dark';
        const next = { ...baseValues(base) };
        if (!(await useTheme('', null, base))) { showInUse(); return; } // not kept: nothing of the editor was touched, a draft stays as it was
        currentEdits = next; lastBase = base;
        renderModal(); document.getElementById('theme-save-base').value = base; syncSaveHint();
        showToast(`Using theme: ${base === 'light' ? 'Light' : 'Dark'}`);
        return;
    }

    try {
        const resp = await fetch(`/api/themes/${encodeURIComponent(name)}`);
        const data = await resp.json();
        if (data.error) {
            showToast(data.error, true);
            return;
        }
        const theme = data.theme;
        const next = { ...baseValues(theme.base === 'light' ? 'light' : 'dark'), ...theme.variables }; // the chosen base's colours with the theme's own over them: the editor is what the page shows, whatever was edited before (#13760)
        if (!(await useTheme(name, theme, theme.base))) { showInUse(); return; } // not kept: the editor (name, description, base, colours, an unsaved draft) is untouched; Load puts it in use now and for the next start, with no new copy
        currentEdits = next; lastBase = theme.base === 'light' ? 'light' : 'dark';
        renderModal();
        // Restore name/desc after re-render
        document.getElementById('theme-save-name').value = name;
        document.getElementById('theme-save-desc').value = theme.description || '';
        document.getElementById('theme-save-base').value = theme.base || 'dark';
        syncSaveHint();
        showToast(`Using theme: ${name}`);
    } catch (e) {
        showToast('Failed to load theme', true);
    }
};

function deleteSelectedTheme() {
    const select = document.getElementById('theme-load-select');
    const name = select.value;
    if (!name) return;
    if (name.startsWith('base:')) { showToast('Dark and Light are built in and cannot be deleted', true); return; }
    window.showConfirmModal('Delete theme', `Delete theme "${name}"?`, async () => { try {
        await fetch(`/api/themes/${encodeURIComponent(name)}`, { method: 'DELETE' });
        // If active theme is being deleted, clear the setting
        if (state.settings.custom_theme === name) {
            await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ custom_theme: '' }),
            });
            state.settings.custom_theme = ''; activeName = '';
        }
        // Refresh theme list
        const resp = await fetch('/api/themes');
        savedThemes = (await resp.json()).themes || [];
        renderModal();
        showToast(`Deleted: ${name}`);
    } catch (e) {
        showToast('Failed to delete theme', true);
    } }, undefined, { label: 'Delete theme', danger: true });
};

(window.__coral ||= {}).exportCurrentTheme = function() {
    const name = document.getElementById('theme-save-name')?.value.trim() || 'coral-theme';
    const description = document.getElementById('theme-save-desc')?.value.trim() || '';
    const base = document.getElementById('theme-save-base')?.value || 'dark';

    const data = { name, description, base, variables: currentEdits };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Theme exported');
};

async function generateThemeFromDescription() {
    const prompt = document.getElementById('theme-ai-prompt')?.value.trim();
    if (!prompt) {
        showToast('Enter a theme description first', true);
        return;
    }

    const base = document.getElementById('theme-save-base')?.value || 'dark';
    const btn = document.getElementById('theme-generate-btn');
    const input = document.getElementById('theme-ai-prompt');
    const origText = btn.textContent;
    btn.textContent = 'Generating...';
    btn.disabled = true;
    if (input) input.disabled = true;

    // Show a persistent progress banner in the editor area
    const scroll = document.querySelector('.theme-editor-scroll');
    let banner = null;
    if (scroll) {
        banner = document.createElement('div');
        banner.className = 'notice notice-info theme-generate-banner';
        banner.innerHTML = '<span class="theme-generate-spinner"></span> Generating theme with AI — this may take 10-20 seconds...';
        scroll.prepend(banner);
    }

    try {
        const resp = await fetch('/api/themes/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: prompt, base }),
        });
        const data = await resp.json();
        if (data.error) {
            const f = runFailure({ error_code: data.code, agent_type: 'claude' }); // 409 not_signed_in (#5469): say what to do
            showToast(f ? `${f.text}. ${f.hint}` : data.error, true);
            return;
        }

        // Merge generated variables into current edits
        const generated = data.variables || {};
        for (const [cssVar, value] of Object.entries(generated)) {
            if (cssVar in currentEdits) {
                currentEdits[cssVar] = value;
            }
        }

        // Capture generated name before re-render
        const generatedName = data.name || '';

        // Re-render the editor with new values
        renderModal();

        // Restore fields after re-render (renderModal rebuilds all inputs)
        const promptInput = document.getElementById('theme-ai-prompt');
        if (promptInput) promptInput.value = prompt;
        if (generatedName) {
            document.getElementById('theme-save-name').value = generatedName;
        }

        syncSaveHint();
        showToast('Theme generated — click Preview to see it live');
    } catch (e) {
        showToast('Failed to generate theme', true);
    } finally {
        if (banner) banner.remove();
        btn.textContent = origText;
        btn.disabled = false;
        if (input) input.disabled = false;
    }
};

function importThemeFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.variables || typeof data.variables !== 'object') {
                showToast('Invalid theme file: missing variables', true);
                return;
            }

            // Upload to server
            const formData = new FormData();
            formData.append('file', file);
            const resp = await fetch('/api/themes/import', { method: 'POST', body: formData });
            const result = await resp.json();
            if (result.error) {
                showToast(result.error, true);
                return;
            }

            // Put it in use first; the editor takes it only when it was kept (a refused save leaves the editor, and any unsaved draft in it, as it was)
            const themesResp = await fetch('/api/themes');
            savedThemes = (await themesResp.json()).themes || [];
            const next = { ...baseValues(data.base === 'light' ? 'light' : 'dark'), ...data.variables };
            const kept = await useTheme(result.name, data, data.base); // an imported theme is stored by the server: it is put in use as Load does, no second copy
            if (kept) {
                currentEdits = next; lastBase = data.base === 'light' ? 'light' : 'dark';
                renderModal();
                document.getElementById('theme-save-name').value = result.name; document.getElementById('theme-save-desc').value = data.description || ''; document.getElementById('theme-save-base').value = data.base || 'dark';
            } else {
                const select = document.getElementById('theme-load-select'); // stored, not in use: it is in the list, and the editor stays as it is
                if (select && ![...select.options].some(o => o.value === result.name)) select.append(new Option(result.name, result.name));
            }
            syncSaveHint();
            showToast(kept ? `Imported and using: ${result.name}` : `Imported: ${result.name}`);
        } catch (e) {
            showToast('Failed to import theme', true);
        }
    };
    input.click();
};

// ── Apply theme on page load ─────────────────────────────────────────────

// ── Utilities ────────────────────────────────────────────────────────────

function applyVariablesToDom(variables) {
    for (const [cssVar, value] of Object.entries(variables)) {
        if (value) {
            document.documentElement.style.setProperty(cssVar, value);
        }
    }
    // Refresh xterm terminal to pick up new --xterm-* variables
    updateTerminalTheme();
}

function toHex(color) {
    if (!color) return '#000000';
    color = color.trim();

    // Already hex
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    if (/^#[0-9a-fA-F]{3}$/.test(color)) {
        return '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3];
    }

    // rgb/rgba
    const rgbMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
        const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
        const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }

    return '#000000';
}

// The theme configurator's color inputs and buttons (#3645): each calls the same function its
// inline handler did.
/** The Based on list changed: the colours the person has not touched take the new base's values, the ones they edited stay. */
async function changeBase(el) {
    const to = el.value === 'light' ? 'light' : 'dark', from = lastBase;
    if (to === from) return;
    const was = baseValues(from), now = baseValues(to), same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    for (const cssVar of Object.keys(currentEdits)) if (same(currentEdits[cssVar], was[cssVar])) currentEdits[cssVar] = now[cssVar];
    lastBase = to;
    const name = document.getElementById('theme-save-name').value, desc = document.getElementById('theme-save-desc').value;
    renderModal();
    document.getElementById('theme-save-name').value = name; document.getElementById('theme-save-desc').value = desc; document.getElementById('theme-save-base').value = to; syncSaveHint();
}

registerActions({
    'theme-base-change': el => changeBase(el),
    'theme-var': el => window.__coral.updateThemeVar(el),
    'theme-var-text': el => window.__coral.updateThemeVarText(el),
    'theme-load': () => loadSelectedTheme(),
    'theme-name-input': () => syncSaveHint(),
    'theme-delete': () => deleteSelectedTheme(),
    'theme-import': () => importThemeFile(),
    'theme-export': () => window.__coral.exportCurrentTheme(),
    'theme-generate': () => generateThemeFromDescription(),
    'theme-close': () => window.hideThemeConfigurator(),
    'theme-reset': () => resetThemeToDefaults(),
    'theme-preview': () => window.__coral.previewTheme(),
    'theme-save': () => window.__coral.saveAndApplyTheme(),
});
