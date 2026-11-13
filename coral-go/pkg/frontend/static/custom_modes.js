/* Custom permission modes (#15950): a mode a person adds in Settings > Agents > Custom permission modes: a name, an agent type and the CLI flags it passes in place of a built-in mode's. They are kept on this
 * computer (GET and PUT /api/custom-modes, Operator only: the PUT replaces the whole list), served beside the built-in modes to every picker (New agent, New team, Restart with changes, Settings' default), and a
 * launch names one as "custom:<id>". The flags are checked by the server against a list per CLI when saved and again at every launch; the form says what is wrong before the save, from the same list.
 * Add mode, Update mode and Remove save at once (applyCustomModes), as the custom models do (#16345): Settings has no Apply button, so a draft kept for one was lost on Close or reload. */
import { requestJson } from './api.js';
import { importOnce } from './import_once.js';
import { el as mk } from './dom_el.js';
import { state } from './state.js';

const ROUTE = '/api/custom-modes';
const PREFIX = 'custom:';
const TYPES = [['claude', 'Claude'], ['codex', 'Codex'], ['agy', 'Antigravity'], ['hermes', 'Hermes']];
const FAMILY = { antigravity: 'agy', gemini: 'agy' };
const family = t => FAMILY[String(t || '').toLowerCase()] || String(t || '').toLowerCase();

let saved = [];   // what the server has: [{ id, agent_type, name, flags, risky }]
let draft = [];
let limits = { max_modes: 50, max_flags: 8, max_name_length: 80, allowed_flags: {} };
let editing = null; // index of the row in its form; -1 for a new one
let host = null;
let loaded = false;
let warm = null;
let mountSettingsView = null; // settings_view.js, read when the Settings block opens: the pickers need none of it

const clone = o => JSON.parse(JSON.stringify(o));
const label = t => (TYPES.find(([k]) => k === family(t)) || [t, t])[1];

export const isCustomMode = v => typeof v === 'string' && v.startsWith(PREFIX);

/** The modes the server has, once: the pickers read them from state.customModes. A page that cannot read them (a hub without the route) has none. */
export function warmCustomModes(force = false) {
    if (!warm || force) warm = requestJson('GET', ROUTE).then(d => { setModes(d && d.modes, d && d.limits); }).catch(() => { setModes([]); });
    return warm;
}

function setModes(list, lim) {
    state.customModes = (Array.isArray(list) ? list : []).filter(m => m && typeof m.id === 'string').map(m => ({ id: m.id, agent_type: String(m.agent_type || ''), name: String(m.name || ''), flags: Array.isArray(m.flags) ? m.flags.map(String) : [], risky: !!m.risky }));
    if (lim) limits = { ...limits, ...lim };
    document.dispatchEvent(new CustomEvent('coral:custom-modes'));
}

/** The custom modes a CLI can run, in the order they were saved. */
export function customModesFor(type) { return (state.customModes || []).filter(m => family(m.agent_type) === family(type)); }
export function customModeById(value) { return isCustomMode(value) ? (state.customModes || []).find(m => PREFIX + m.id === value) || null : null; }

/** The words for a custom mode's pick: its name, with its flags where there is room (a help line, a title). */
export function customModeFlagsLine(m) { return m ? m.flags.join(' ') : ''; }

/** Puts the custom modes of the CLI into a mode select, after the built-in ones, in a group of their own; a pick that is no longer there falls to Default. */
export function syncCustomModeOptions(select, type) {
    if (!select) return;
    // The pick is read before the old group goes: removing the selected option would reset it.
    const was = select.value;
    select.querySelectorAll('optgroup[data-custom-modes]').forEach(g => g.remove());
    const mine = type ? customModesFor(type) : state.customModes || [];
    if (mine.length) {
        const group = mk('optgroup'); group.label = 'Custom'; group.dataset.customModes = '1';
        for (const m of mine) {
            const o = new Option(m.risky ? `${m.name} (no prompts)` : m.name, PREFIX + m.id);
            if (m.risky) o.dataset.risky = '1'; // New Agent's "Runs as" line reads it for the amber warning (#16777)
            o.title = customModeFlagsLine(m) ? `Runs with: ${customModeFlagsLine(m)}` : '';
            if (type == null || type === '') o.textContent = `${m.name} (${label(m.agent_type)})`;
            group.append(o);
        }
        select.append(group);
    }
    // The first sync restores a custom pick the form was drawn with (its option did not exist yet); later ones keep what the person has chosen.
    const want = select.dataset.customSynced ? was : (select.dataset.initial || was);
    select.dataset.customSynced = '1';
    if (isCustomMode(want) && [...select.options].some(o => o.value === want)) select.value = want;
    else if (isCustomMode(select.value) && ![...select.options].some(o => o.value === select.value)) select.value = type == null || type === '' ? '' : 'default';
}

// ── Settings > Agents > Custom permission modes ───────────────────────────────

export function customModesPayload() {
    return { modes: draft.map(m => ({ ...(m.id ? { id: m.id } : {}), agent_type: m.agent_type, name: m.name, flags: [...m.flags] })) };
}
export function customModesDirty() { return loaded && JSON.stringify(customModesPayload()) !== JSON.stringify((() => { const d = draft; draft = saved; const p = customModesPayload(); draft = d; return p; })()); }

/** The one-flag-per-line text of a form's box as the server's list. */
export const parseFlagLines = text => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

/** The reason these flags are not accepted for the CLI, or '': the server's rule, read here so the form can say it before the save. */
export function flagsProblem(type, flags) {
    if (!flags.length) return 'Enter at least one flag.';
    if (flags.length > (limits.max_flags || 8)) return `At most ${limits.max_flags || 8} lines.`;
    const allowed = (limits.allowed_flags && limits.allowed_flags[family(type)]) || [];
    if (!allowed.length) return `${label(type)} has no permission flags a custom mode can carry.`;
    const table = allowed.map(line => { const m = /^(.*?)(?: <(.*)>)?$/.exec(line); return { names: m[1].split(', ').map(s => s.trim()), values: m[2] ? m[2].split('|') : null }; });
    const owned = new Set(); const seen = new Set();
    for (let i = 0; i < flags.length; i++) {
        let tok = flags[i], inline = null;
        if (!/^[A-Za-z0-9._=:,+[\]/-]+$/.test(tok)) return `Line ${i + 1}: letters, numbers and . _ = : , + [ ] / - only; one flag or value per line, no spaces or quotes.`;
        if (!tok.startsWith('-') || tok === '--') return `Line ${i + 1}: ${tok} is not a flag. A value goes on the line after its flag.`;
        const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
        if (eq > 0) { inline = tok.slice(eq + 1); tok = tok.slice(0, eq); }
        const spec = table.find(s => s.names.includes(tok));
        if (!spec) return `Line ${i + 1}: ${tok} is not a permission flag a custom mode can carry for ${label(type)}. Allowed: ${allowed.join('; ')}.`;
        if (!spec.values && inline != null) return `Line ${i + 1}: ${tok} takes no value.`;
        if (spec.values) {
            const v = inline != null ? inline : flags[++i];
            if (v == null) return `Line ${i + 1}: ${tok} needs a value (${spec.values.join(', ')}).`;
            if (!spec.values.includes(v)) return `Line ${i + 1}: ${tok} takes ${spec.values.join(', ')}.`;
        }
        if (seen.has(spec.names[0])) return `Line ${i + 1}: ${tok} is given twice.`;
        seen.add(spec.names[0]); void owned;
    }
    return '';
}

function status() {
    const s = host && host.querySelector('.cm-status');
    if (s) s.textContent = '';
}

let feedbackTimer;
function feedback(words) {
    clearTimeout(feedbackTimer);
    const s = host && host.querySelector('.cm-status');
    if (!s) return;
    s.textContent = words;
    if (words === 'Saved') feedbackTimer = setTimeout(() => { s.textContent = ''; }, 2000);
}
const notSaved = error => (error && error.userMessage ? `Not saved. ${error.userMessage} Try again.` : 'Not saved. Try again.');

function nameProblem(type, name, skip) {
    if (!name) return 'Enter a name.';
    if (name.length > (limits.max_name_length || 80)) return `Up to ${limits.max_name_length || 80} characters.`;
    if (draft.some((m, i) => i !== skip && family(m.agent_type) === family(type) && m.name.toLowerCase() === name.toLowerCase())) return `${label(type)} already has a mode called ${name}.`;
    return '';
}

function form(index) {
    const cur = index >= 0 ? draft[index] : { agent_type: TYPES[0][0], name: '', flags: [] };
    const box = mk('div', 'cm-form');
    const typeOf = v => (v && v.agent_type) || cur.agent_type;
    const fields = [
        { key: 'agent_type', type: 'select', id: 'cpm-type', label: 'Agent type', default: cur.agent_type, options: TYPES.map(([value, lab]) => ({ value, label: lab })) },
        { key: 'name', type: 'text', id: 'cpm-name', label: 'Name', required: true, requiredMessage: 'Enter a name.', messageAsIs: true, attrs: { maxlength: String(limits.max_name_length || 80), autocomplete: 'off' },
            validate: (v, values) => nameProblem(typeOf(values), String(v || '').trim(), index) },
        { key: 'flags', type: 'textarea', id: 'cpm-flags', label: 'Flags', rows: 4, required: true, requiredMessage: 'Enter at least one flag.', messageAsIs: true, attrs: { autocomplete: 'off', spellcheck: 'false' },
            help: 'One flag or value per line, in place of the built-in mode\'s flags. Only the permission flags of the CLI are accepted; Coral checks them again at every launch.',
            setup: e => e.classList.add('settings-mono-input'),
            validate: (v, values) => flagsProblem(typeOf(values), parseFlagLines(v)) },
        { key: 'allowed', type: 'notice', render: slot => { slot.append(mk('p', 'sv-help cpm-allowed', '')); } },
    ];
    const view = mountSettingsView(box, { mode: 'form', fields, form: {
        submit: index >= 0 ? 'Update mode' : 'Add mode', cancel: 'Cancel',
        onSubmit: async values => {
            const entry = { id: index >= 0 ? draft[index].id : '', agent_type: values.agent_type, name: String(values.name).trim(), flags: parseFlagLines(values.flags) };
            if (index >= 0) draft[index] = { ...draft[index], ...entry }; else draft.push(entry);
            const at = index >= 0 ? index : draft.length - 1;
            try { await applyCustomModes(); feedback('Saved'); focusAfter(at); }
            catch (error) { draft = clone(saved); editing = null; render(); feedback(notSaved(error)); }
        },
        onCancel: () => { editing = null; render(); focusAdd(); },
    } });
    view.set('name', cur.name); view.set('flags', cur.flags.join('\n'));
    const hint = box.querySelector('.cpm-allowed');
    const showAllowed = () => { const t = (box.querySelector('[name="agent_type"]') || {}).value || cur.agent_type; const a = (limits.allowed_flags && limits.allowed_flags[family(t)]) || []; if (hint) hint.textContent = a.length ? `${label(t)} flags: ${a.join(' · ')}` : ''; };
    showAllowed(); box.addEventListener('change', showAllowed);
    // the command the mode would start the agent with (#15951), read off the server's launch builder as the flags are typed; a flag the form refuses keeps it from being shown, and the line says why
    const cmdSlot = mk('div', 'cpm-command'); if (hint && hint.parentNode) hint.parentNode.append(cmdSlot);
    let cmdSeq = 0, cmdTimer = 0;
    const showCommand = () => {
        const t = (box.querySelector('[name="agent_type"]') || {}).value || cur.agent_type, flags = parseFlagLines((box.querySelector('[name="flags"]') || {}).value);
        const mine = ++cmdSeq; clearTimeout(cmdTimer);
        if (!flags.length) { cmdSlot.replaceChildren(); return; }
        const problem = flagsProblem(t, flags);
        if (problem) { cmdSlot.replaceChildren(mk('p', 'sv-help cpm-command-refused', `Start command: not shown until every flag is accepted. ${problem}`)); return; }
        cmdTimer = setTimeout(async () => {
            const { fetchFlags, commandNode } = await importOnce('./permission_flags_line.js');
            const answer = await fetchFlags(null, { agent_type: t, permission_mode: 'default', flags });
            if (mine === cmdSeq) cmdSlot.replaceChildren(...(answer && answer.command ? [commandNode(String(answer.command))] : []));
        }, 150);
    };
    box.addEventListener('input', showCommand); box.addEventListener('change', showCommand); showCommand();
    box.querySelector('.sv-cancel').setAttribute('aria-label', index >= 0 ? 'Cancel the mode change' : 'Cancel adding a mode');
    box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); view.cancel(); } });
    return { f: box, focus: () => view.focus(index < 0 ? 'agent_type' : 'name') };
}

function focusAdd() { const b = host && host.querySelector('[data-cpm-add]'); if (b) b.focus(); }
function focusAfter(i) { const b = host && host.querySelector(`[data-cpm-edit="${i}"]`); if (b) b.focus(); else focusAdd(); }

function render() {
    if (!host) return;
    host.replaceChildren();
    const list = mk('ul', 'cm-list');
    draft.forEach((m, i) => {
        const li = mk('li', 'cm-row'); li.dataset.type = m.agent_type;
        if (editing === i) { const fm = form(i); li.append(fm.f); list.append(li); queueMicrotask(fm.focus); return; }
        const risky = isRisky(m);
        const text = mk('span', 'cm-text'); text.append(mk('span', 'cm-provider', label(m.agent_type)), mk('span', 'cm-name', m.name), mk('code', 'cm-id', m.flags.join(' ')));
        if (risky) text.append(mk('span', 'chip chip-tag cm-chip cpm-risky', 'No prompts'));
        const edit = mk('button', 'btn btn-small', 'Edit'); edit.type = 'button'; edit.dataset.cpmEdit = String(i); edit.setAttribute('aria-label', `Edit ${m.name}`);
        edit.addEventListener('click', () => { editing = i; render(); });
        const rm = mk('button', 'btn btn-small', 'Remove'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove ${m.name}`);
        rm.addEventListener('click', async () => {
            rm.disabled = true; draft.splice(i, 1); editing = null;
            try { await applyCustomModes(); feedback('Saved'); focusAdd(); }
            catch (error) { draft = clone(saved); render(); feedback(notSaved(error)); }
        });
        li.append(text, edit, rm); list.append(li);
    });
    host.append(list);
    if (editing === -1) { const fm = form(-1); host.append(fm.f); queueMicrotask(fm.focus); }
    else {
        const add = mk('button', 'btn btn-small cm-add', 'Add a custom mode'); add.type = 'button'; add.dataset.cpmAdd = '1';
        add.disabled = draft.length >= (limits.max_modes || 50);
        add.addEventListener('click', () => { editing = -1; render(); });
        host.append(add);
    }
    const st = mk('p', 'cm-status settings-hint'); st.setAttribute('role', 'status'); st.setAttribute('aria-live', 'polite');
    host.append(st);
    status();
}

// A mode that turns the prompts off, judged here only for the badge (the server's own judgement, risky, is what the pickers show once saved): the flags that say so, in every spelling.
function isRisky(m) {
    if (typeof m.risky === 'boolean' && saved.some(s => s.id && s.id === m.id)) { const s = saved.find(x => x.id === m.id); if (JSON.stringify(s.flags) === JSON.stringify(m.flags)) return s.risky; }
    const f = m.flags.join(' ');
    return /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo|bypassPermissions|danger-full-access|(-a|--ask-for-approval)[ =]never/.test(f);
}

/** Draws the section into #settings-custom-modes from the server's list; the row stays hidden when the server has no such route. */
export async function initCustomModes() {
    host = document.getElementById('settings-custom-modes');
    const row = host && host.closest('.sv-row');
    if (!host) return;
    let data;
    try { mountSettingsView = (await importOnce('./settings_view.js')).mountSettingsView; data = await requestJson('GET', ROUTE); } catch { loaded = false; if (row) row.hidden = true; return; }
    const kept = loaded && customModesDirty();
    saved = (data && data.modes) || [];
    if (data && data.limits) limits = { ...limits, ...data.limits };
    if (!kept) { draft = clone(saved); editing = null; }
    loaded = true;
    if (row) row.hidden = false;
    setModes(saved, null);
    render();
}

/** Saves the draft when it changed (Apply). Resolves true when something was saved; throws with the server's reason when it refuses. */
export async function applyCustomModes() {
    if (!customModesDirty()) return false;
    let data;
    try { data = await requestJson('PUT', ROUTE, customModesPayload()); } catch (e) {
        const d = (e && e.data) || {};
        e.userMessage = typeof d.error === 'string' && d.error ? d.error : (typeof d.message === 'string' ? d.message : 'the custom permission modes were not saved');
        throw e;
    }
    saved = (data && data.modes) || clone(draft);
    draft = clone(saved); editing = null;
    setModes(saved, data && data.limits);
    render();
    return true;
}

/** The dialog was closed: unsaved changes are dropped. */
export function discardCustomModes() {
    draft = clone(saved); editing = null;
    if (host) render();
}
