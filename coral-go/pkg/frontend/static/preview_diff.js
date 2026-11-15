/* Read-only preview diffs and their line comments (#17546). Loaded only when Diff opens. */
import { importOnce } from './import_once.js';
import { getCm, getLangExtension, getLangFromPath, diffMergeView, plainWholeLineMarks, cmHost, cmTheme } from './cm_util.js';
import { retryOnce } from './overload.js';
import { _renderContentView } from './preview_content.js';
export async function mountPreviewDiff(tab, body, current, { _fileUrl, _setBody }) {
        if (tab.originalContent === null) {
            _setBody('<div class="preview-pane-loading">Loading…</div>');
            try {
                const resp = await retryOnce(() => fetch(_fileUrl('file-original', tab.filepath)));
                const data = await resp.json();
                if (!current()) return;
                tab.originalContent = data.error ? '' : (data.content || '');
            } catch {
                if (current()) _setBody('<div class="preview-pane-error">Failed to load diff</div>');
                return;
            }
        }
        tab.hasDiff = tab.originalContent !== tab.content;
        const cm = tab.hasDiff ? getCm() : null;
        if (cm) {
            try {
                const host = cmHost(body);
                const merge = diffMergeView(cm, tab.originalContent, tab.content);
                const extensions = [
                    cm.basicSetup, ...cmTheme(cm), cm.EditorView.lineWrapping,
                    cm.EditorView.editable.of(false), cm.EditorState.readOnly.of(true),
                    cm.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
                    // diffConfig: the merge view's own scanLimit would otherwise return one chunk.
                    // mergeControls off: the view is read-only, so its Accept and Reject buttons would do nothing when clicked.
                    merge,
                ];
                const langExt = getLangExtension(cm, getLangFromPath(tab.filepath));
                if (langExt) extensions.push(langExt);
                const view = new cm.EditorView({ state: cm.EditorState.create({ doc: tab.content, extensions }), parent: host });
                plainWholeLineMarks(view);
                let m;
                try { m = await importOnce('./diff_comments.js'); } catch (e) { view.destroy(); throw e; }
                if (!current()) { view.destroy(); return null; }
                body.classList.add('file-diff'); const drawing = String(Date.now() + Math.random()); body.dataset.drawing = drawing;
                try { await m.attachDiffComments(body, { filepath: tab.filepath }, view, { original: tab.originalContent, content: tab.content }, 'Preview diff', m.mergeFields(merge)); } catch (e) { if (body.dataset.drawing === drawing) { m.detachDiffComments(body); delete body.dataset.drawing; body.classList.remove('file-diff'); } view.destroy(); throw e; }
                const destroy = view.destroy.bind(view);
                view.destroy = () => { if (body.dataset.drawing === drawing) { m.detachDiffComments(body); delete body.dataset.drawing; body.classList.remove('file-diff'); } destroy(); };
                if (!current()) { view.destroy(); return null; }
                return view;
            } catch (e) {
                console.error('[coral] CodeMirror merge view creation failed:', e);
                if (!current()) return null;
                body.replaceChildren();
            }
        }
        _renderContentView(body, tab.content, tab.filepath, tab.line, false);
    }
