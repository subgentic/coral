/* The New goal screen, direction A "Writing room" (#12724, the Operator's pick from the three mockups): a roomy editor in a near-full-screen sheet (a phone's own screen), with the title, what should be true (a
 * Markdown-lite toolbar), done when, the pictures, the team and the driver. It creates the same goal the old dialog did: POST /api/board/<team>/goals with createBody's body. Local rules only (no model, no
 * agent call). Lazy: goals_view.js openCreate imports it when New goal is pressed. Everything drawn is built with the DOM and textContent. */
import { loadStyles } from './lazy_styles.js';
import { boardFetch, keyLabel } from './server_base.js';
import { OPERATOR_ID, showToast } from './utils.js';
import { toDrivers, createBody, errorOf } from './goals_adapter.js';
import { importOnce } from './import_once.js';
import * as W from './goal_words.js';
import { PHONE_QUERY } from './phone_layout.js';
await loadStyles('goal_editor.css'); // not at start (page_weight): the editor's own sheet loads with this module, before anything draws
const GOAL_DESCRIPTION_MAX = 2000; // the server's cap on a goal's outcome (MaxGoalOutcome)

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, onClick) => { const b = el('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };

/** An Error carrying the route's code and sentence (or the status when the answer is not JSON). */
async function failure(r) {
    let e = { code: '', message: '' };
    try { e = errorOf(await r.json()); } catch { /* the status stays */ }
    return Object.assign(new Error(e.message || `${r.status}`), { code: e.code });
}

// ── the Markdown-lite toolbar: each action edits the textarea's text, keeping the undo stack where the browser allows (execCommand), and tells the page it changed ──
function replaceRange(field, from, to, text, selFrom, selTo) {
    field.focus(); field.setSelectionRange(from, to);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { /* the plain write below */ }
    if (!done || field.value.slice(from, from + text.length) !== text) { field.setRangeText(text, from, to, 'end'); field.dispatchEvent(new Event('input', { bubbles: true })); }
    field.setSelectionRange(selFrom, selTo);
}
const lineStart = (v, i) => v.lastIndexOf('\n', i - 1) + 1;
/** Wrap the selection in `mark` (bold, italic, code); with none selected, the marks go around the cursor. Marks already around the selection come off. */
export function wrapSelection(field, mark) {
    const { value: v, selectionStart: a, selectionEnd: b } = field, n = mark.length;
    if (a >= n && v.slice(a - n, a) === mark && v.slice(b, b + n) === mark) { replaceRange(field, a - n, b + n, v.slice(a, b), a - n, b - n); return; }
    const sel = v.slice(a, b);
    replaceRange(field, a, b, mark + sel + mark, a + n, a + n + sel.length);
}
/** Put `prefix` at the start of every line the selection touches (a heading, bullets, checkboxes); lines that already have it lose it. */
export function prefixLines(field, prefix) {
    const { value: v, selectionStart: a, selectionEnd: b } = field;
    const from = lineStart(v, a), endAt = v.indexOf('\n', b), to = endAt < 0 ? v.length : endAt;
    const lines = v.slice(from, to).split('\n'), all = lines.every(l => l.startsWith(prefix));
    const out = lines.map(l => (all ? l.slice(prefix.length) : l.startsWith(prefix) ? l : prefix + l)).join('\n');
    replaceRange(field, from, to, out, from, from + out.length);
}
/** A link: the selection is the text, and the address is selected for typing. */
export function linkSelection(field) {
    const { value: v, selectionStart: a, selectionEnd: b } = field, sel = v.slice(a, b) || 'text', url = 'https://';
    const text = `[${sel}](${url})`, at = a + sel.length + 3;
    replaceRange(field, a, b, text, at, at + url.length);
}
/** Enter at the end of a bullet or checkbox line starts the next one; Enter on an empty one ends the list. */
function continueList(field, e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || field.selectionStart !== field.selectionEnd) return;
    const v = field.value, at = field.selectionStart, from = lineStart(v, at), line = v.slice(from, at), m = /^(\s*)(- \[[ x]\] |- )(.*)$/.exec(line);
    if (!m || v.slice(at, v.indexOf('\n', at) < 0 ? v.length : v.indexOf('\n', at)) !== '') return;
    e.preventDefault();
    if (!m[3]) { replaceRange(field, from, at, '', from, from); return; }
    const next = `\n${m[1]}${m[2].startsWith('- [') ? '- [ ] ' : '- '}`;
    replaceRange(field, at, at, next, at + next.length, at + next.length);
}
const TOOLS = [
    { key: 'bold', label: 'Bold', glyph: 'B', cls: 'goal-tb-bold', keys: 'Ctrl+B', run: f => wrapSelection(f, '**') },
    { key: 'italic', label: 'Italic', glyph: 'I', cls: 'goal-tb-italic', keys: 'Ctrl+I', run: f => wrapSelection(f, '*') },
    { key: 'heading', label: 'Heading', icon: 'title', run: f => prefixLines(f, '## ') },
    { sep: true },
    { key: 'bullets', label: 'Bulleted list', glyph: '•', run: f => prefixLines(f, '- ') },
    { key: 'checks', label: 'Checklist', icon: 'check_box', run: f => prefixLines(f, '- [ ] ') },
    { key: 'code', label: 'Code', icon: 'code', run: f => wrapSelection(f, '`') },
    { key: 'link', label: 'Link', icon: 'link', run: f => linkSelection(f) },
];

/** The New goal screen. opts: { project, teams: [{ key, label }], onCreated(project), onClose() }. With more than one team the screen asks which (the one the caller named is chosen). Resolves nothing: it reports through onCreated and onClose. */
export function openGoalEditor(opts = {}) {
    let project = opts.project;
    const dlg = el('dialog', 'dlg-confirm goals-dialog goal-editor'); dlg.setAttribute('aria-labelledby', 'goals-create-title');
    const form = el('form', 'goals-form goal-form'); form.noValidate = true;

    // the bar: back, the title, the team and the driver as chips
    const title = el('h3', null, 'New goal'); title.id = 'goals-create-title';
    const back = btn('goals-form-back', null, () => dlg.close()); back.setAttribute('aria-label', 'Back'); back.title = 'Back'; const arrow = el('span', 'material-icons', 'arrow_back'); arrow.setAttribute('aria-hidden', 'true'); back.append(arrow);
    const chip = (label, control, id) => { const l = el('label', 'goal-scope'); l.append(el('span', 'goal-scope-lab', label), control); control.id = id; return l; };
    const dr = el('select'); dr.disabled = true; dr.append(new Option('Loading this board\'s agents…', '')); // the board's own agents: the route refuses a name that is not a subscriber
    const teams = opts.teams && opts.teams.length > 1 ? opts.teams : null, pick = el('select'); // the Inbox spans teams: which one gets the goal
    if (teams) for (const t of teams) pick.append(new Option(t.label, t.key));
    const chips = el('div', 'goal-scopes');
    if (teams) { pick.value = project; chips.append(chip('Team', pick, 'goal-new-team')); }
    else { const c = el('span', 'goal-scope goal-scope-fixed'); c.append(el('span', 'goal-scope-lab', 'Team'), el('b', null, keyLabel(project))); chips.append(c); }
    chips.append(chip('Driver', dr, 'goal-new-driver'));
    const head = el('div', 'goals-form-head'); head.append(back, title);

    // the writing: the title, what should be true (with its toolbar), done when
    const t = el('input', 'goal-title'); t.type = 'text'; t.maxLength = 200; t.autocomplete = 'off'; t.id = 'goal-new-title'; t.placeholder = 'Name the goal'; t.setAttribute('aria-label', 'Title (required)');
    const desc = el('textarea', 'goal-outcome'); desc.id = 'goal-new-description'; desc.rows = 10; desc.maxLength = GOAL_DESCRIPTION_MAX; desc.placeholder = 'Say what should be true when this is done. Drop or paste a picture to add it.';
    const descLab = el('label', 'goal-label', 'What should be true'); descLab.htmlFor = 'goal-new-description';
    const descCount = el('span', 'goals-count'); descCount.hidden = true; descCount.setAttribute('role', 'status');
    desc.addEventListener('input', () => { const n = desc.value.length; descCount.hidden = n < GOAL_DESCRIPTION_MAX - 500; descCount.textContent = `${n} / ${GOAL_DESCRIPTION_MAX}`; }); // the count shows only near the limit
    const bar = el('div', 'goal-toolbar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Formatting'); bar.setAttribute('aria-controls', 'goal-new-description');
    for (const tool of TOOLS) {
        if (tool.sep) { bar.append(el('span', 'goal-tb-sep')); continue; }
        const b = btn(`goal-tb ${tool.cls || ''}`.trim(), null, () => tool.run(desc)); b.dataset.tool = tool.key; b.setAttribute('aria-label', tool.label); b.title = tool.keys ? `${tool.label} (${tool.keys})` : tool.label;
        if (tool.icon) { const i = el('span', 'material-icons', tool.icon); i.setAttribute('aria-hidden', 'true'); b.append(i); } else { const g = el('span', 'goal-tb-glyph', tool.glyph); g.setAttribute('aria-hidden', 'true'); b.append(g); }
        b.addEventListener('mousedown', e => e.preventDefault()); // the text keeps its selection and focus
        bar.append(b);
    }
    // arrow keys move along the toolbar (one tab stop)
    const tools = () => [...bar.querySelectorAll('.goal-tb')];
    bar.addEventListener('keydown', e => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const all = tools(), i = all.indexOf(document.activeElement); if (i < 0) return; e.preventDefault(); all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].focus(); });
    desc.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrapSelection(desc, e.key === 'b' ? '**' : '*'); return; }
        continueList(desc, e);
    });
    const d = el('input'); d.type = 'text'; d.maxLength = 300; d.autocomplete = 'off'; d.id = 'goal-new-done'; d.placeholder = 'What a person can check';
    const doneLab = el('label', 'goal-label'); doneLab.htmlFor = 'goal-new-done'; doneLab.append('Done when ', el('span', 'goal-label-note', '· one thing a person can check (optional)'));
    const pics = el('div', 'goals-pics'); let tray = null; // the pictures of the goal: the comment box's tray, loaded when the form opens
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert');
    const main = el('div', 'goals-form-body goal-main'); main.append(t, descLab, bar, desc, descCount, el('div', 'goal-gap'), doneLab, d, pics, err);

    const go = btn('btn btn-primary', 'Create goal'); go.type = 'submit';
    const cancel = btn('btn', 'Cancel', () => dlg.close());
    const actions = el('div', 'goals-actions'); actions.append(cancel, go);
    const phone = matchMedia(PHONE_QUERY); // the bar is back and the title on a phone (56 px, as every form screen), the chips are the first line of the body; on a desktop they sit in the bar
    const place = () => { if (phone.matches) main.prepend(chips); else head.append(chips); };
    place(); phone.addEventListener('change', place);
    form.append(head, actions, main);
    dlg.append(form); document.body.append(dlg);

    const loadDrivers = () => { const asked = project; return boardFetch(asked, '/subscribers').then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).then(json => {
        if (asked !== project) return; // the team was changed while this answer was on its way: it is the other team's agents (a slower answer must not fill the list)
        const people = toDrivers(json);
        dr.replaceChildren(...people.map(p => new Option(p.label, p.id)), new Option('No driver yet', ''));
        dr.value = people.length && people[0].orchestrator ? people[0].id : ''; // the Orchestrator drives unless the person says otherwise
        dr.disabled = false;
    }).catch(() => { if (asked !== project) return; dr.replaceChildren(new Option('No driver yet', '')); dr.disabled = false; err.textContent = 'This board\'s agents could not be read, so no driver is set.'; }); };
    loadDrivers();
    const uploadImage = async (blob, versionOf) => { // a team route: the picture is stored before the goal exists, on the team the goal is for
        const r = await boardFetch(project, `/goal-images${versionOf ? `?version_of=${encodeURIComponent(versionOf)}` : ''}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        let j = {}; try { j = await r.json(); } catch { /* an answer that is not JSON has no reason */ }
        if (!r.ok || !/^[0-9a-f]{64}$/.test(String(j.hex || ''))) throw new Error((j && typeof j.error === 'string' && j.error) || `The picture was not stored (HTTP ${r.status}).`);
        return { hex: j.hex, name: String(j.name || ''), contentType: String(j.content_type || blob.type), size: Number(j.size) || blob.size };
    };
    const sync = () => { go.disabled = !!tray && (tray.busy() || tray.failed()); }; // Create waits for a picture going up, and for a failed one to be removed
    importOnce('./artifact_comment_images.js').then(m => {
        if (!dlg.isConnected) return;
        tray = m.createImageTray({ upload: uploadImage }); tray.attach(form, desc); tray.listen(sync);
        pics.append(tray.picker(), tray.hint(), tray.node);
    }).catch(() => { /* a goal needs no picture: the form works without the button */ });
    pick.addEventListener('change', () => { if (tray) tray.clear('The pictures were taken out: they were stored on the other team.'); project = pick.value; dr.disabled = true; dr.replaceChildren(new Option('Loading this board\'s agents…', '')); loadDrivers(); });
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        if (!t.value.trim()) { err.textContent = 'A goal needs a title.'; t.setAttribute('aria-invalid', 'true'); t.focus(); return; }
        t.removeAttribute('aria-invalid'); go.disabled = true;
        try {
            const r = await boardFetch(project, '/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createBody({ title: t.value, description: desc.value, doneWhen: d.value, driver: dr.value, images: tray ? tray.hexes() : [], by: OPERATOR_ID })) });
            if (!r.ok) throw await failure(r);
            dlg.close();
            const made = await r.json().catch(() => null), told = !!(made && made.orchestrator_told_at); // the toast only when it was told (#11880)
            if (told) showToast('Goal created. The Orchestrator was told.');
            if (opts.onCreated) await opts.onCreated(project, told);
        } catch (ex) { err.textContent = `The goal was not created: ${W.errorWords(ex && ex.code, ex && ex.message)}`; go.disabled = false; sync(); }
    });
    dlg.addEventListener('close', () => { if (tray) tray.destroy(); dlg.remove(); if (opts.onClose) opts.onClose(); });
    dlg.showModal(); t.focus();
    return dlg;
}
