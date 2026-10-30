/* Inline diffs in the Files panel (#11350, the operator: "an inline expand for diffs ... a reviewer can expand all of their files and see an entire change"). A changed file's row can open its diff right under
 * it, read-only, collapsed to the changed hunks with the same colours and highlighting as the preview pane's Diff; the panel's Expand all stacks every file's diff in the list's order, so the whole change reads
 * top to bottom. The preview pane is untouched: a click on the row still opens it. A binary file says so and points at the preview; a very long file is cut off and its diff is read on request, never at once. */
import { serverUrl, currentServer } from './server_base.js';
import { agentName, apiQs } from './agent_file_api.js';
import { retryOnce } from './overload.js';
import { isImagePath, isMediaPath } from './utils.js';
import { loadCodeMirror } from './vendor_loader.js';
import { getCm, getLangExtension, getLangFromPath, DIFF_CONFIG, cmHost, cmTheme } from './cm_util.js';

/** A file longer than this many lines is not diffed until the person asks: a stack of big diffs must not stall the panel. */
export const BIG_LINES = 4000;
const reads = new Map(); // `${path}|${signature}` -> the two texts, so a redraw of the list does not read them again
const views = new WeakMap(); // slot -> the editor mounted in it

const url = (endpoint, filepath) => serverUrl(`/api/sessions/live/${encodeURIComponent(agentName())}/${endpoint}?${apiQs(filepath)}`, currentServer());
const lines = text => (text ? text.split('\n').length : 0);

function note(slot, text, tone) {
    const p = document.createElement('p');
    p.className = `file-diff-note${tone ? ` file-diff-${tone}` : ''}`;
    p.textContent = text;
    slot.replaceChildren(p);
    return p;
}

async function readTexts(file) {
    const key = `${file.filepath}|${file.status}|${file.additions || 0}|${file.deletions || 0}`;
    if (reads.has(key)) return reads.get(key);
    const get = async endpoint => { const resp = await retryOnce(() => fetch(url(endpoint, file.filepath))); const data = await resp.json(); return data.error ? '' : (data.content || ''); };
    const [original, content] = await Promise.all([get('file-original'), get('file-content')]);
    if (reads.size > 200) reads.clear();
    const both = { original, content };
    reads.set(key, both);
    return both;
}

function drop(slot) {
    const view = views.get(slot);
    if (view) { try { view.destroy(); } catch { /* already gone */ } views.delete(slot); }
}

async function mount(slot, file, { original, content }) {
    if (!window.CoralCM) await loadCodeMirror();
    const cm = getCm();
    if (!cm) throw new Error('no editor');
    const body = document.createElement('div');
    body.className = 'file-diff-body';
    slot.replaceChildren(body);
    const host = cmHost(body);
    const extensions = [
        cm.basicSetup, ...cmTheme(cm), cm.EditorView.lineWrapping,
        cm.EditorView.editable.of(false), cm.EditorState.readOnly.of(true),
        cm.EditorView.theme({ '.cm-scroller': { overflow: 'auto' } }),
        // collapsed to the changed hunks, as the preview's diff is: the unchanged lines between them are one click each
        cm.unifiedMergeView({ original: cm.Text.of(original.split('\n')), diffConfig: DIFF_CONFIG, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } }),
    ];
    const langExt = getLangExtension(cm, getLangFromPath(file.filepath));
    if (langExt) extensions.push(langExt);
    views.set(slot, new cm.EditorView({ state: cm.EditorState.create({ doc: content, extensions }), parent: host }));
}

/** Draws the file's diff into its slot (a block under its row), or what stands in for it. force: a long file's diff the person asked for. */
export async function showFileDiff(slot, file, force = false) {
    if (!slot || !file) return;
    slot.hidden = false;
    if (slot.dataset.shown === `${file.filepath}|${file.status}|${file.additions || 0}|${file.deletions || 0}|${force ? 1 : 0}` && (views.has(slot) || slot.querySelector('.file-diff-note'))) return; // drawn already, and the file has not moved
    drop(slot);
    if (isImagePath(file.filepath) || isMediaPath(file.filepath)) { note(slot, 'A binary file has no text diff. Open it to see it before and after.'); slot.dataset.shown = `${file.filepath}|${file.status}|${file.additions || 0}|${file.deletions || 0}|${force ? 1 : 0}`; return; }
    note(slot, 'Loading the changes…');
    const drawing = String(Date.now() + Math.random()); // a slot hidden, or redrawn for another file, while the texts are read is not written to
    slot.dataset.drawing = drawing;
    try {
        const texts = await readTexts(file);
        if (slot.dataset.drawing !== drawing || slot.hidden) return;
        if (texts.original === texts.content) { note(slot, 'No changes to show.'); }
        else if (!force && Math.max(lines(texts.original), lines(texts.content)) > BIG_LINES) {
            const p = note(slot, `A long file (${Math.max(lines(texts.original), lines(texts.content)).toLocaleString()} lines): its diff is not drawn until you ask. `);
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-small file-diff-more'; b.textContent = 'Show the diff';
            b.addEventListener('click', () => showFileDiff(slot, file, true));
            p.append(b);
        } else await mount(slot, file, texts);
        slot.dataset.shown = `${file.filepath}|${file.status}|${file.additions || 0}|${file.deletions || 0}|${force ? 1 : 0}`;
    } catch {
        if (slot.dataset.drawing === drawing) note(slot, 'Could not load the changes. Open the file to see it.', 'error');
    }
}

/** Closes the slot: its editor is destroyed and nothing is kept in it. */
export function hideFileDiff(slot) {
    if (!slot) return;
    slot.dataset.drawing = '';
    slot.dataset.shown = '';
    drop(slot);
    slot.replaceChildren();
    slot.hidden = true;
}
