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
const { assess, EXAMPLES, TASKS_MAX } = await importOnce('./goal_guide.js'); // lazy: its failure is retried
const { renderGoalText } = await importOnce('./goal_text.js'); // the Preview and the goal's page draw the words the same way
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
    { sep: true },
    { key: 'image', label: 'Add a picture', icon: 'image', run: () => {} }, // opens the picture picker (wired where the tray exists)
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
    const descLab = el('label', 'goal-field-label', 'What should be true'); descLab.htmlFor = 'goal-new-description';
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
    const doneLab = el('label', 'goal-field-label'); doneLab.htmlFor = 'goal-new-done'; doneLab.append('Done when ', el('span', 'goal-field-label-note', '· one thing a person can check (optional)'));
    const doneChips = el('div', 'goal-done-signs'); doneChips.setAttribute('aria-label', 'What the done-when has'); // under Done when: the checks as small notes
    const pics = el('div', 'goals-pics goal-pics'); let tray = null; // the pictures of the goal: the comment box's tray, loaded when the form opens
    const picLab = el('div', 'goal-field-label', 'Pictures'); picLab.id = 'goal-picbox-label';
    const picRow = el('div', 'goal-picrow'); picRow.setAttribute('role', 'group'); picRow.setAttribute('aria-labelledby', 'goal-picbox-label');
    const err = el('p', 'goals-field-error'); err.setAttribute('role', 'alert');
    const main = el('div', 'goals-form-body goal-writing'); main.append(t, descLab, bar, desc, descCount, el('div', 'goal-gap'), doneLab, d, doneChips, picLab, pics, err);

    // the Guide rail: the board's rules for how big a goal is, as local checks that follow the words (goal_guide.js; no model, no agent)
    const guide = el('section', 'goal-card goal-guide'); guide.setAttribute('aria-labelledby', 'goal-guide-title');
    const gTitle = el('h4', null, 'Guide'); gTitle.id = 'goal-guide-title'; const gNote = el('span', 'goal-guide-note', ' \u00b7 updates as you write'); gTitle.append(gNote);
    const gSummary = el('p', 'goal-guide-summary'); gSummary.setAttribute('role', 'status'); gSummary.setAttribute('aria-live', 'polite'); // said once, a moment after the words stop
    const gChecks = el('ul', 'goal-checks');
    const gSize = el('div', 'goal-size'), gSizeLab = el('div', 'goal-field-label', 'Likely size'), meter = el('div', 'goal-meter'), fill = el('i'), gSizeWords = el('p', 'goal-size-words');
    meter.append(fill); gSize.append(gSizeLab, meter, gSizeWords);
    guide.append(gTitle, gSummary, gChecks, gSize);
    const examples = el('section', 'goal-card goal-examples'); examples.setAttribute('aria-labelledby', 'goal-examples-title');
    const exTitle = el('h4', null, 'A good \u201cdone when\u201d'); exTitle.id = 'goal-examples-title';
    const exList = el('ul', 'goal-example-list');
    for (const text of EXAMPLES.slice(0, 2)) { const li = el('li'), b = btn('goal-example', `\u201c${text}\u201d`, () => { d.value = text; d.dispatchEvent(new Event('input', { bubbles: true })); d.focus(); }); b.setAttribute('aria-label', `Use this done-when: ${text}`); li.append(b); exList.append(li); }
    examples.append(exTitle, exList);
    const previewCard = el('section', 'goal-card goal-preview-card'); previewCard.setAttribute('aria-labelledby', 'goal-preview-card-title');
    const pvTitle = el('h4', null, 'Preview'); pvTitle.id = 'goal-preview-card-title';
    const pvOpen = btn('btn goal-preview-open', 'Open preview', () => togglePreview(true)); // the same as the bar's Preview
    previewCard.append(pvTitle, el('p', 'goal-guide-note', 'See how this reads on its page before you create it.'), pvOpen);
    const rail = el('aside', 'goal-rail'); rail.setAttribute('aria-label', 'Guide'); rail.append(guide, examples, previewCard);
    const ICON = { ok: 'check_circle', warn: 'warning', todo: 'info' };
    let summaryTimer = null;
    const refresh = () => {
        const a = assess({ title: t.value, outcome: desc.value, doneWhen: d.value });
        gChecks.replaceChildren(...a.checks.map(c => { const li = el('li', `goal-check goal-check-${c.state}`), i = el('span', 'material-icons', ICON[c.state]); i.setAttribute('aria-hidden', 'true'); const body = el('div'); body.append(el('b', null, c.title), el('small', null, c.why)); li.append(i, body); li.dataset.check = c.id; return li; }));
        doneChips.replaceChildren(...a.chips.map(c => el('span', `goal-done-sign goal-done-${c.state}`, c.text)));
        const share = a.size.steps ? Math.min(a.size.steps / TASKS_MAX, 1) : 0;
        fill.style.width = `${Math.round(share * 100)}%`; meter.dataset.state = a.size.state; gSizeWords.textContent = a.size.words;
        meter.setAttribute('role', 'img'); meter.setAttribute('aria-label', a.size.words);
        clearTimeout(summaryTimer); summaryTimer = setTimeout(() => { gSummary.textContent = a.summary; }, 600);
        gSummary.dataset.looks = String(a.looks);
    };
    for (const f of [t, desc, d]) f.addEventListener('input', refresh);
    refresh(); gSummary.textContent = 'Nothing to look at';
    const go = btn('btn btn-primary', 'Create goal'); go.type = 'submit';
    const cancel = btn('btn', 'Cancel', () => dlg.close());
    const previewBtn = btn('btn btn-quiet goal-preview-toggle', 'Preview', () => togglePreview()); previewBtn.setAttribute('aria-pressed', 'false'); previewBtn.title = 'See how the goal will read on its page';
    const actions = el('div', 'goals-actions'); actions.append(previewBtn, cancel, go);
    // the Preview: the goal as its page will show it (the title, the state, the driver, the description as Markdown-lite, done when, the pictures), drawn the same way (goal_text.js); Edit goes back
    const pane = el('section', 'goal-preview'); pane.hidden = true; pane.setAttribute('aria-label', 'Preview of the goal'); let previewUrls = [];
    const drawPreview = async () => {
        for (const u of previewUrls) URL.revokeObjectURL(u); previewUrls = [];
        const who = dr.selectedOptions[0] && dr.value ? dr.selectedOptions[0].textContent : '', teamName = keyLabel(project);
        const state = el('span', 'goal-preview-state', 'Proposed'), h = el('h2', 'goal-preview-title', t.value.trim() || 'Untitled goal'); h.tabIndex = -1; if (!t.value.trim()) h.classList.add('goal-preview-blank');
        const meta = el('p', 'goal-preview-meta', [who ? `Driver: ${who}` : 'No driver yet', teamName].join(' \u00b7 '));
        const dl = el('dl', 'facts goals-facts');
        const dd = el('dd'); dl.append(el('dt', null, 'Description'), dd);
        if (desc.value.trim()) { const node = await renderGoalText(desc.value); dd.append(node); } else { dd.textContent = 'Nothing written yet.'; dd.classList.add('goal-preview-blank'); }
        const dd2 = el('dd', d.value.trim() ? null : 'goal-preview-blank', d.value.trim() || 'Not set yet.'); dl.append(el('dt', null, 'Done when'), dd2);
        const kids = [state, h, meta, dl];
        const shots = tray ? tray.items().filter(x => x.state === 'ready') : [];
        if (shots.length) { const row = el('ul', 'goal-preview-pics'); for (const x of shots) { const li = el('li'), img = el('img'); const u = URL.createObjectURL(x.blob); previewUrls.push(u); img.src = u; img.alt = x.name || 'Picture'; li.append(img); row.append(li); } kids.push(row); }
        kids.push(el('p', 'goal-preview-tasks', 'No tasks yet. The goal\u2019s driver plans them once it exists.'));
        pane.replaceChildren(...kids);
        return h;
    };
    let previewing = false;
    async function togglePreview(on = !previewing) {
        previewing = on; previewBtn.setAttribute('aria-pressed', String(on)); previewBtn.textContent = on ? 'Edit' : 'Preview';
        if (on) { const h = await drawPreview(); if (!previewing) return; main.hidden = true; pane.hidden = false; rail.classList.add('goal-rail-quiet'); h.focus(); }
        else { pane.hidden = true; main.hidden = false; rail.classList.remove('goal-rail-quiet'); t.focus(); }
    }
    const phone = matchMedia(PHONE_QUERY); // the bar is back and the title on a phone (56 px, as every form screen), the chips are the first line of the body; on a desktop they sit in the bar
    const place = () => { if (phone.matches) { main.prepend(chips); main.append(rail); } else { head.append(chips); form.append(rail); } };
    place(); phone.addEventListener('change', place);
    form.append(head, actions, main, pane);
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
    const sync = () => { go.disabled = !!tray && (tray.busy() || tray.failed()); picLab.textContent = tray && tray.items().length ? `Pictures \u00b7 ${tray.items().length}` : 'Pictures'; }; // Create waits for a picture going up, and for a failed one to be removed
    importOnce('./artifact_comment_images.js').then(m => {
        if (!dlg.isConnected) return;
        tray = m.createImageTray({ upload: uploadImage }); tray.attach(form, desc); tray.listen(sync);
        const picker = tray.picker(), add = picker.querySelector('button'); add.textContent = 'Drop, paste or choose'; add.classList.add('goal-drop'); add.setAttribute('aria-label', 'Add a picture to this goal');
        picRow.append(tray.node, picker); pics.append(picRow, tray.hint());
        bar.querySelector('[data-tool="image"]').addEventListener('click', () => picker.querySelector('input').click());
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
    dlg.addEventListener('close', () => { clearTimeout(summaryTimer); for (const u of previewUrls) URL.revokeObjectURL(u); if (tray) tray.destroy(); dlg.remove(); if (opts.onClose) opts.onClose(); });
    dlg.showModal(); t.focus();
    return dlg;
}
