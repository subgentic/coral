/* settings_view: one settings surface, drawn from a schema (#7744). A caller passes a spec (groups, fields, load, save); the component draws the nav, the rows, the help, the errors and
 * the save bar, tracks what changed and hands the caller only the changes. Persistence and side effects stay with the caller. Every visual choice is a --sv-* token (variables.css) read by
 * settings_view.css; no surface styles a settings row of its own.
 *
 *   const view = mountSettingsView(host, spec);
 *
 *   spec = {
 *     mode: 'settings' | 'form',        direction only: settings = label and hint at the left, the control at the right, one save bar; form = label above, hint under it, control full width, no nav, no bar
 *     groups: [{ id, label, icon, hint?, fields: [...] , render?(host, view) }],     or fields: [...] for one flat list
 *     group: 'id',                      the group open first (a deep link); onGroup(id) is called when it changes; remember: 'key' keeps the last group per surface
 *     load: async () => ({ key: value }),
 *     save: async (changes, ctx) => ({ saved?: [words], note?: 'text' }),    changes = only the changed fields; ctx = { before, values }
 *     saveBar: { save: 'Save settings', cancel: 'Cancel', onCancel? } | false,
 *     readOnly: false | 'reason' | (key) => false | 'reason',
 *     words: { none, dirty, saved, failed, busy },  onApply(key, value) for apply: 'now' fields
 *   }
 *   field = { key, type: 'text'|'textarea'|'number'|'select'|'toggle'|'multiselect'|'radio'|'secret'|'path'|'custom', label, help?: string | { text, more },
 *             id?, default?, required?, placeholder?, rows?, min?, max?, step?, unit?, options?: [{ value, label, help? }] | async () => [...], validate?(value, values) => '' | 'message',
 *             visibleWhen?(values), disabledWhen?(values) => bool | 'reason', readOnly?, apply?: 'now', action?: { label, run(view), danger?, confirm? }, wide?, render?(slot, ctl) => { get, set, onChange? } }
 *
 * The controller: values() set(key, v) dirty() isDirty() changes() error(key, message) clearErrors() validate({ focus }) save() cancel() showGroup(id) reload() destroy().
 * Events on the host: 'sv-dirty' { dirty }, 'sv-group' { id }, 'sv-saved' { changes }. */
import { importOnce } from './import_once.js';
import { browserLocal } from './safe_storage.js';
import { storeKey } from './local_store.js';

const { initSectionDialog, showSection, markSectionError } = await importOnce('./section_dialog.js'); // the nav: the shared sectioned shell (lazy, loaded through importOnce, so a failed load is retried)

let seq = 0;
const WORDS = { none: 'No changes to save.', dirty: 'You have unsaved changes.', saved: 'Saved.', failed: 'Could not save: ', busy: 'Saving\u2026' };

function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

/** A value as a comparable string (the control's own value, not how it is drawn). */
function norm(v) {
    if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v).trim();
}

/** The paragraphs of a long help text (a blank line between them); plain text, never markup. */
function paragraphs(text) {
    return String(text).split(/\n{2,}/).map(t => node('p', '', t.trim())).filter(p => p.textContent);
}

export function mountSettingsView(host, spec) {
    const uid = `sv${++seq}`;
    const mode = spec.mode === 'form' ? 'form' : 'settings';
    const words = { ...WORDS, ...(spec.words || {}) };
    const groups = (spec.groups && spec.groups.length ? spec.groups : [{ id: 'all', label: '', fields: spec.fields || [] }]).filter(g => g.render || g.fields);
    const fields = new Map();      // key -> { field, group, row, ctl, errorEl, helpEl, baseline }
    const errors = new Map();      // key -> message
    const applied = new Map();     // key -> the value an apply-now field last had (a click fires input and change: one call, not two)
    let baseline = {};             // key -> the loaded value (raw)
    let busy = false, lastSaved = false, status = null, statusError = false, destroyed = false;
    let view = null; // the controller, assigned below (a group's render and a field's action may be called before it exists, and use it later)
    let shell = null, bar = null, saveBtn = null, cancelBtn = null, statusEl = null, announce = () => {};

    const root = node('div', mode === 'form' ? 'sv sv-form' : 'sv sv-settings');
    root.dataset.mode = mode;
    root.id = `${uid}-root`;
    const readOnlyOf = key => (typeof spec.readOnly === 'function' ? spec.readOnly(key) : spec.readOnly) || false;
    const reasonOf = r => (typeof r === 'string' ? r : '');
    const globalReadOnly = typeof spec.readOnly === 'string' || spec.readOnly === true ? spec.readOnly : false;
    if (typeof globalReadOnly === 'string' && globalReadOnly) root.append(node('p', 'sv-lead', globalReadOnly));
    else if (spec.lead) root.append(node('p', 'sv-lead', spec.lead));
    const partsDirty = () => (spec.parts ? spec.parts() : []).filter(p => p && p.dirty());  // parts: pieces the caller draws and saves itself (a group's own form); they count in the bar

    // -- the controls, one builder per type: each returns { get, set, node, focus, disable(on) } ----------
    function optionsOf(field, apply) {
        const given = field.options;
        const fill = list => apply(list || []);
        if (typeof given === 'function') { Promise.resolve(given()).then(fill).catch(() => fill([])); return []; }
        return given || [];
    }
    function buildControl(field, id) {
        const common = e => { if (field.required) e.setAttribute('aria-required', 'true'); return e; };
        const t = field.type || 'text';
        if (t === 'toggle') {
            const input = node('input', 'sv-switch'); input.type = 'checkbox'; input.id = field.id || `${id}-c`; input.name = field.key;
            const hit = node('label', 'check-hit sv-switch-hit'); hit.htmlFor = input.id; hit.append(input);
            return { node: hit, input, get: () => input.checked, set: v => { input.checked = !!v; }, focus: () => input.focus(), disable: on => { input.disabled = on; }, labelledBy: true };
        }
        if (t === 'select') {
            const sel = node('select', 'sv-input sv-select'); sel.id = field.id || `${id}-c`; sel.name = field.key;
            let want = '';
            const draw = list => { sel.replaceChildren(...list.map(o => { const op = node('option', '', o.label); op.value = String(o.value); return op; })); sel.value = want; if (sel.value !== want && sel.options.length) sel.selectedIndex = 0; };
            draw(optionsOf(field, draw));
            return { node: sel, input: sel, get: () => sel.value, set: v => { want = v === undefined || v === null ? '' : String(v); sel.value = want; if (sel.value !== want && sel.options.length) sel.selectedIndex = 0; }, focus: () => sel.focus(), disable: on => { sel.disabled = on; } };
        }
        if (t === 'textarea') {
            const ta = common(node('textarea', 'sv-input sv-textarea')); ta.id = field.id || `${id}-c`; ta.name = field.key; ta.rows = field.rows || 4;
            if (field.placeholder) ta.placeholder = field.placeholder;
            return { node: ta, input: ta, get: () => ta.value, set: v => { ta.value = v ?? ''; }, focus: () => ta.focus(), disable: on => { ta.disabled = on; } };
        }
        if (t === 'radio' || t === 'multiselect') {
            const box = node('div', 'sv-choices'); box.setAttribute('role', t === 'radio' ? 'radiogroup' : 'group'); box.id = field.id || `${id}-c`;
            const inputs = [];
            let want = t === 'radio' ? '' : [];
            const apply = () => { const w = Array.isArray(want) ? want.map(String) : [String(want ?? '')]; for (const i of inputs) i.checked = w.includes(i.value); };
            const draw = list => {
                inputs.length = 0;
                box.replaceChildren(...list.map((o, i) => { const lab = node('label', 'sv-choice'); const inp = node('input'); inp.type = t === 'radio' ? 'radio' : 'checkbox'; inp.name = field.key; inp.value = String(o.value); inp.id = `${id}-c${i}`; inputs.push(inp); lab.append(inp, node('span', 'sv-choice-text', o.label)); if (o.help) lab.append(node('span', 'sv-choice-help', o.help)); return lab; }));
                apply();
            };
            draw(optionsOf(field, draw));
            return { node: box, get: () => (t === 'radio' ? ((inputs.find(i => i.checked) || {}).value ?? '') : inputs.filter(i => i.checked).map(i => i.value)), set: v => { want = v; apply(); }, focus: () => (inputs.find(i => i.checked) || inputs[0])?.focus(), disable: on => { for (const i of inputs) i.disabled = on; }, group: true };
        }
        if (t === 'custom') {
            const slot = node('div', 'sv-custom'); slot.id = field.id || `${id}-c`;
            const api = field.render ? field.render(slot, { field, host: root }) || {} : {};
            return { node: slot, get: api.get || (() => undefined), set: api.set || (() => {}), focus: () => (slot.querySelector('input, select, textarea, button') || slot).focus?.(), disable: on => { api.disable?.(on); for (const e of slot.querySelectorAll('input, select, textarea, button')) e.disabled = on; }, onChange: api.onChange, custom: true };
        }
        const input = common(node('input', 'sv-input')); input.id = field.id || `${id}-c`; input.name = field.key;
        input.type = t === 'secret' ? 'password' : t === 'number' ? 'number' : 'text';
        if (t === 'secret') input.autocomplete = 'off';
        if (t === 'path') { input.spellcheck = false; input.autocapitalize = 'none'; }
        if (t === 'number') { if (field.min !== undefined) input.min = field.min; if (field.max !== undefined) input.max = field.max; if (field.step !== undefined) input.step = field.step; }
        if (field.placeholder) input.placeholder = field.placeholder;
        const get = () => (t === 'number' ? (input.value.trim() === '' ? null : Number(input.value)) : input.value);
        return { node: input, input, get, set: v => { input.value = v === undefined || v === null ? '' : String(v); }, focus: () => input.focus(), disable: on => { input.disabled = on; } };
    }

    function buildRow(field, group) {
        const id = `${uid}-${fields.size}`;
        const t = field.type || 'text';
        const row = node('div', `sv-row sv-row-${t}${field.wide ? ' sv-row-wide' : ''}`);
        row.dataset.key = field.key;
        const text = node('div', 'sv-text');
        const label = node('label', 'sv-label', field.label); label.id = `${id}-l`;
        const ctl = buildControl(field, id);
        if (ctl.input && !ctl.group && !ctl.custom) label.htmlFor = ctl.input.id; else if (ctl.group || ctl.custom) { label.removeAttribute('for'); ctl.node.setAttribute('aria-labelledby', `${id}-l`); }
        if (ctl.labelledBy) { ctl.input.setAttribute('aria-labelledby', `${id}-l`); label.removeAttribute('for'); }
        text.append(label);
        if (field.required) text.append(node('span', 'sv-required', 'Required'));
        // the help: one line under the label; a long text behind Learn more; "Applies immediately" for a switch that saves at once
        const helpBits = [];
        const help = typeof field.help === 'string' ? { text: field.help } : field.help || null;
        let helpEl = null;
        if (help && help.text) helpBits.push(help.text);
        if (field.apply === 'now') helpBits.push('Applies immediately.');
        if (helpBits.length || (help && help.more)) {
            helpEl = node('p', 'sv-help'); helpEl.id = `${id}-h`;
            helpEl.append(node('span', 'sv-help-text', helpBits.join(' ')));
            if (help && help.more) {
                const more = node('div', 'sv-more'); more.id = `${id}-m`; more.hidden = true; more.append(...paragraphs(help.more));
                const btn = node('button', 'sv-learn', 'Learn more'); btn.type = 'button'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', more.id);
                const named = () => { if (help.about) btn.setAttribute('aria-label', `${btn.textContent} about ${help.about}`); }; named(); // help.about: what it is about, for the screen reader ("Learn more about working modes")
                btn.addEventListener('click', () => { more.hidden = !more.hidden; btn.setAttribute('aria-expanded', String(!more.hidden)); btn.textContent = more.hidden ? 'Learn more' : 'Show less'; named(); });
                helpEl.append(' ', btn); text.append(helpEl, more);
            } else text.append(helpEl);
        }
        const target = ctl.input || ctl.node;
        if (helpEl && target && target.setAttribute) target.setAttribute('aria-describedby', helpEl.id);
        const control = node('div', 'sv-control');
        control.append(ctl.node);
        if (field.unit) control.append(node('span', 'sv-unit', field.unit));
        let actionEl = null;
        if (field.action) {
            const a = field.action;
            actionEl = node('button', `btn sv-action${a.danger ? ' btn-danger sv-danger' : ''}`, a.label); actionEl.type = 'button';
            const runIt = async () => { actionEl.disabled = true; try { await a.run(view); } finally { actionEl.disabled = false; } };
            actionEl.addEventListener('click', () => {
                if (!a.confirm) { runIt(); return; }
                const box = node('span', 'sv-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', `Confirm: ${a.label}`);
                const yes = node('button', 'btn btn-danger sv-confirm-yes', a.label); yes.type = 'button';
                const no = node('button', 'btn sv-confirm-no', 'Cancel'); no.type = 'button';
                box.append(node('span', 'sv-confirm-text', a.confirm), yes, no);
                actionEl.hidden = true; actionEl.after(box); yes.focus();
                const close = () => { box.remove(); actionEl.hidden = false; actionEl.focus(); };
                no.addEventListener('click', close);
                box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
                yes.addEventListener('click', async () => { box.remove(); actionEl.hidden = false; await runIt(); actionEl.focus(); });
            });
            control.append(actionEl);
        }
        const errorEl = node('p', 'sv-error'); errorEl.id = `${id}-e`; errorEl.hidden = true; errorEl.setAttribute('role', 'alert');
        row.append(text, control, errorEl);
        const rec = { field, group, row, ctl, errorEl, helpEl, actionEl, id, label };
        const onEdit = () => touched(field.key);
        for (const ev of ['input', 'change']) (ctl.node).addEventListener(ev, onEdit);
        if (ctl.onChange) ctl.onChange(onEdit);
        return rec;
    }

    // -- the structure: the groups as panes of the shared sectioned shell (nav list, select on a phone) --------
    function pane(group) {
        const p = node('section', 'settings-pane sv-pane');
        p.dataset.section = group.id; p.dataset.title = group.label; p.dataset.icon = group.icon || 'tune'; p.dataset.desc = group.hint || '';
        if (group.render) { group.render(p, view); return p; }
        for (const field of group.fields) {
            if (!field.key) continue;
            const rec = buildRow(field, group);
            fields.set(field.key, rec);
            p.append(rec.row);
        }
        return p;
    }
    const flat = mode === 'form' || (groups.length === 1 && !groups[0].label);
    if (flat) {
        const body = node('div', 'sv-body');
        for (const g of groups) for (const field of g.fields || []) { if (!field.key) continue; const rec = buildRow(field, g); fields.set(field.key, rec); body.append(rec.row); }
        root.append(body);
    } else {
        shell = node('div', 'settings-shell sv-shell');
        const label = spec.label || 'Settings sections';
        const nav = node('nav', 'settings-nav'); nav.setAttribute('aria-label', label);
        const pick = node('div', 'settings-group-pick'); const sel = node('select', 'settings-select'); sel.setAttribute('aria-label', spec.groupLabel || `${label} group`); pick.append(sel);
        const tabs = node('div', 'settings-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-orientation', 'vertical'); tabs.setAttribute('aria-label', label);
        nav.append(pick, tabs);
        const panes = node('div', 'settings-panes');
        for (const g of groups) panes.append(pane(g));
        shell.append(nav, panes);
        root.append(shell);
    }
    // the bar: status at the left, Cancel and Save at the right (settings mode; a form's dialog has its own footer)
    const barSpec = mode === 'settings' && spec.saveBar !== false ? { save: 'Save settings', cancel: 'Cancel', ...(spec.saveBar || {}) } : null;
    if (barSpec) {
        bar = node('footer', 'sv-bar');
        statusEl = node('span', 'sv-status', words.none); statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
        const buttons = node('div', 'sv-bar-buttons');
        cancelBtn = node('button', 'btn sv-cancel', barSpec.cancel); cancelBtn.type = 'button'; cancelBtn.disabled = true;
        saveBtn = node('button', 'btn btn-primary sv-save', barSpec.save); saveBtn.type = 'button'; saveBtn.disabled = true;
        buttons.append(cancelBtn, saveBtn); bar.append(statusEl, buttons); root.append(bar);
        cancelBtn.addEventListener('click', () => view.cancel());
        saveBtn.addEventListener('click', () => { view.save(); });
        root.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !saveBtn.disabled) { e.preventDefault(); view.save(); } });
    }
    host.append(root);
    if (spec.parts) for (const ev of ['input', 'change']) root.addEventListener(ev, () => setTimeout(() => { if (!destroyed) afterChange(); }, 0)); // a part's own controls: the bar follows them after the part's handlers have run
    if (shell) {
        initSectionDialog(shell);
        const remember = spec.remember ? storeKey(`sv-group-${spec.remember}`) : null;
        const first = spec.group || (remember && browserLocal.get(remember)) || groups[0].id;
        showSection(shell, first);
        announce = () => { const id = shell.querySelector('.settings-pane:not([hidden])')?.dataset.section; if (!id) return; if (remember) browserLocal.set(remember, id); spec.onGroup?.(id); root.dispatchEvent(new CustomEvent('sv-group', { bubbles: true, detail: { id } })); };
        shell.querySelector('.settings-tabs')?.addEventListener('click', () => queueMicrotask(announce));
        shell.querySelector('.settings-tabs')?.addEventListener('keydown', () => queueMicrotask(announce));
        shell.querySelector('.settings-group-pick select')?.addEventListener('change', () => queueMicrotask(announce));
    }

    // -- state: values, dirty, errors, the bar -------------------------------------------------------------
    const valuesNow = () => { const o = {}; for (const [k, r] of fields) o[k] = r.ctl.get(); return o; };
    const dirtyKeys = () => { const s = new Set(); for (const [k, r] of fields) { if (r.field.apply === 'now') continue; if (norm(r.ctl.get()) !== norm(baseline[k] === undefined ? r.field.default : baseline[k])) s.add(k); } return s; };
    function refreshRows() {
        const values = valuesNow();
        for (const [k, r] of fields) {
            const vis = r.field.visibleWhen ? !!r.field.visibleWhen(values) : true;
            r.row.hidden = !vis;
            const ro = readOnlyOf(k) || r.field.readOnly || false;
            const dis = r.field.disabledWhen ? r.field.disabledWhen(values) : false;
            const off = !!(globalReadOnly || ro || dis);
            r.ctl.disable(off);
            if (r.actionEl) r.actionEl.disabled = off && !!(globalReadOnly || ro);
            const why = reasonOf(ro) || reasonOf(dis);
            if (off) r.row.setAttribute('data-disabled', '1'); else r.row.removeAttribute('data-disabled');
            if (r.helpEl) { const t = r.helpEl.querySelector('.sv-help-text'); r.baseHelp = r.baseHelp ?? t.textContent; t.textContent = why ? `${why}${r.baseHelp ? ' ' + r.baseHelp : ''}` : r.baseHelp; }
        }
    }
    function paintBar() {
        const dirty = dirtyKeys().size > 0 || partsDirty().length > 0;
        if (saveBtn) { saveBtn.disabled = !dirty || busy || !!globalReadOnly; cancelBtn.disabled = !dirty || busy; }
        if (statusEl) {
            const text = busy ? words.busy : status !== null ? status : dirty ? words.dirty : lastSaved ? words.saved : words.none;
            statusEl.textContent = text; statusEl.classList.toggle('is-error', statusError && !busy);
        }
        root.dataset.dirty = dirty ? '1' : '';
        if (!dirty) delete root.dataset.dirty;
        return dirty;
    }
    let wasDirty = false;
    function afterChange() {
        refreshRows();
        const dirty = paintBar();
        if (dirty !== wasDirty) { wasDirty = dirty; root.dispatchEvent(new CustomEvent('sv-dirty', { bubbles: true, detail: { dirty } })); }
    }
    function touched(key) {
        const r = fields.get(key);
        if (!r) return;
        if (r.field.apply === 'now') { const now = r.ctl.get(); if (norm(now) !== norm(applied.get(key))) { applied.set(key, now); spec.onApply?.(key, now); } } else { lastSaved = false; status = null; statusError = false; }
        if (errors.has(key)) checkField(key); // an error clears as soon as the value is fine
        afterChange();
    }
    function showError(key, message) {
        const r = fields.get(key);
        if (!r) return;
        if (!message) { errors.delete(key); r.errorEl.hidden = true; r.errorEl.textContent = ''; const t = r.ctl.input || r.ctl.node; t?.removeAttribute?.('aria-invalid'); describe(r, false); }
        else {
            const text = new RegExp(r.field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(message) ? message : `${r.field.label}: ${message}`; // the message names the field
            errors.set(key, text); r.errorEl.textContent = text; r.errorEl.hidden = false;
            const t = r.ctl.input || r.ctl.node; t?.setAttribute?.('aria-invalid', 'true'); describe(r, true);
        }
        if (shell) { const p = r.row.closest('.settings-pane[data-section]'); if (p) markSectionError(shell, p.dataset.section, !!p.querySelector('[aria-invalid="true"]')); }
    }
    function describe(r, on) {
        const t = r.ctl.input || r.ctl.node; if (!t || !t.setAttribute) return;
        const own = new Set([r.helpEl && r.helpEl.id, r.errorEl.id].filter(Boolean));
        const extra = (t.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && !own.has(x)); // what the caller added (a line of its own) stays
        const ids = [r.helpEl && r.helpEl.id, ...extra, on && r.errorEl.id].filter(Boolean);
        if (ids.length) t.setAttribute('aria-describedby', ids.join(' ')); else t.removeAttribute('aria-describedby');
    }
    function checkField(key) {
        const r = fields.get(key);
        if (!r || r.row.hidden) return true;
        const v = r.ctl.get();
        let msg = '';
        if (r.field.required && (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length))) msg = 'is required.';
        if (!msg && r.field.validate) msg = r.field.validate(v, valuesNow()) || '';
        showError(key, msg);
        return !msg;
    }

    // -- the controller ------------------------------------------------------------------------------------
    view = {
        host: root,
        values: valuesNow,
        set(key, value) { const r = fields.get(key); if (r) { r.ctl.set(value); afterChange(); } },
        dirty: dirtyKeys,
        isDirty: () => dirtyKeys().size > 0 || partsDirty().length > 0,
        refresh: afterChange,
        say(text, isError = false) { status = text || null; statusError = !!isError && !!text; paintBar(); }, // a line of the caller's own in the bar (a part saved elsewhere, a load that failed)
        changes() { const o = {}; for (const k of dirtyKeys()) if (!(readOnlyOf(k) || fields.get(k).field.readOnly || fields.get(k).row.hidden)) o[k] = fields.get(k).ctl.get(); return o; },
        error: showError,
        clearErrors() { for (const k of [...errors.keys()]) showError(k, ''); },
        validate({ focus = false } = {}) {
            let first = null;
            for (const k of fields.keys()) if (!checkField(k) && !first) first = k;
            if (first && focus) { const r = fields.get(first); if (shell) { const p = r.row.closest('.settings-pane[data-section]'); if (p && p.hidden) showSection(shell, p.dataset.section); } r.ctl.focus(); }
            return { ok: !first, first };
        },
        async save() {
            if (busy) return null;
            const v = view.validate({ focus: true });
            if (!v.ok) { status = `${errors.size === 1 ? '1 field needs' : `${errors.size} fields need`} attention.`; statusError = true; paintBar(); return null; }
            const changes = view.changes();
            const owing = partsDirty();
            if (!Object.keys(changes).length && !owing.length) { status = words.none; statusError = false; paintBar(); return null; }
            busy = true; status = null; statusError = false; paintBar();
            const failures = []; let result = {}; let named = [];
            if (Object.keys(changes).length) {
                try {
                    const before = { ...baseline };
                    result = (await spec.save(changes, { before, values: valuesNow() })) || {};
                    for (const k of Object.keys(changes)) baseline[k] = fields.get(k).ctl.get();
                } catch (e) {
                    for (const k of (e && e.saved) || []) if (fields.has(k)) baseline[k] = fields.get(k).ctl.get(); // what was saved before the failure is no longer a change
                    named = e && e.fields ? Object.entries(e.fields) : [];
                    failures.push((e && (e.userMessage || e.message)) || 'no answer');
                }
            }
            for (const part of owing) { try { const why = await part.save(); if (why) failures.push(why); } catch (e) { failures.push((e && e.message) || 'no answer'); } }
            busy = false;
            if (failures.length) {
                for (const [k, m] of named) showError(k, m);
                status = `${words.failed}${spec.failure ? spec.failure(failures[0]) : failures[0]}`; statusError = true;
                afterChange();
                if (named.length) fields.get(named[0][0])?.ctl.focus();
                return null;
            }
            lastSaved = true; status = result.note || null; statusError = false;
            afterChange();
            root.dispatchEvent(new CustomEvent('sv-saved', { bubbles: true, detail: { changes } }));
            return result;
        },
        cancel() {
            for (const [k, r] of fields) if (r.field.apply !== 'now') r.ctl.set(baseline[k] === undefined ? r.field.default : baseline[k]);
            view.clearErrors(); status = null; statusError = false; lastSaved = false;
            afterChange();
            barSpec && barSpec.onCancel && barSpec.onCancel();
        },
        showGroup(id) { if (shell) { showSection(shell, id); announce(); } },
        removeGroup(id) { // a group that does not apply (known only after the load): its nav entry and its pane go
            if (!shell) return;
            const open = view.group() === id;
            for (const e of shell.querySelectorAll(`[data-section="${id}"], .settings-group-pick option[value="${id}"]`)) e.remove();
            if (open) { const next = shell.querySelector('.settings-pane')?.dataset.section; if (next) showSection(shell, next); }
        },
        group() { return shell?.querySelector('.settings-pane:not([hidden])')?.dataset.section || null; },
        async reload() {
            const loaded = (await spec.load?.()) || {};
            if (destroyed) return;
            baseline = { ...loaded };
            for (const [k, r] of fields) { r.ctl.set(loaded[k] === undefined ? r.field.default : loaded[k]); applied.set(k, r.ctl.get()); }
            view.clearErrors(); status = null; statusError = false; lastSaved = false; wasDirty = false;
            refreshRows(); paintBar();
            root.dataset.ready = '1'; // read: the values are in (a caller or a test waits for this)
        },
        destroy() { destroyed = true; root.remove(); },
        ready: null,
    };
    refreshRows(); paintBar();
    view.ready = view.reload();
    return view;
}
