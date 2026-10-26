/* The active preview editor and read-only diff, including capture and disposal. */
import { escapeHtml } from './utils.js';
import { getCm, getLangExtension, getLangFromPath, DIFF_CONFIG } from './cm_util.js';
import { isCloud } from './server_base.js';
import { retryOnce } from './overload.js';
import { _renderContentView } from './preview_content.js';

export function createPreviewEditor({ _activeTab, _isDirty, _renderTabs, _fileUrl, _setBody }) {

    let _cmView = null;        // editor or merge view for the active tab
    let _fallbackEditor = null;

    function _destroyEditor() {
        if (_cmView) { _cmView.destroy(); _cmView = null; }
        _fallbackEditor = null;
    }

    /** Copy edits out of the live editor into the tab before it is torn down. */
    function _captureEditor() {
        const tab = _activeTab();
        if (!tab || tab.kind !== 'file' || tab.mode !== 'edit') return;
        if (_cmView) tab.content = _cmView.state.doc.toString();
        else if (_fallbackEditor) tab.content = _fallbackEditor.value;
    }

    /** The element an editor mounts into. CodeMirror writes its theme into <style> elements, which the hub's CSP
     *  (style-src 'self') blocks; inside a shadow root it adopts a constructable stylesheet instead, which the CSP does
     *  not govern. So in cloud mode the editor lives in a shadow root and the page rules that style it (the same ones
     *  agentic.css/output.css hold for local mode) come from a stylesheet loaded from /static: no inline style anywhere. */
    function _cmHost(body) {
        body.replaceChildren();
        const host = document.createElement('div');
        host.className = 'inline-preview-cm preview-pane-cm';
        body.appendChild(host);
        if (!isCloud() || !host.attachShadow) return host;
        const root = host.attachShadow({ mode: 'open' });
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('./css/cm_shadow.css', import.meta.url).href; // inherits a versioned static prefix
        const mount = document.createElement('div');
        mount.className = 'cm-shadow-mount';
        root.append(link, mount);
        return mount;
    }

    /** The editor's colours follow the page's theme (#7654): CodeMirror's own light look in the light theme, One Dark only in the dark one. Taken when the editor is made, as each file or tab opens it afresh. */
    function _cmTheme(cm) {
        return document.documentElement.getAttribute('data-theme') === 'light' ? [] : [cm.oneDark];
    }

    function _mountEditor(tab, body) {
        const cm = getCm();
        if (cm) {
            try {
                const host = _cmHost(body);
                const extensions = [
                    cm.basicSetup, ..._cmTheme(cm), cm.search(), cm.EditorView.lineWrapping,
                    cm.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
                    cm.EditorView.updateListener.of(u => {
                        if (!u.docChanged) return;
                        const wasDirty = _isDirty(tab);
                        tab.content = u.state.doc.toString();
                        if (_isDirty(tab)) tab.pinned = true;
                        if (wasDirty !== _isDirty(tab) || !tab.pinned) _renderTabs();
                    }),
                ];
                const langExt = getLangExtension(cm, getLangFromPath(tab.filepath));
                if (langExt) extensions.push(langExt);
                _cmView = new cm.EditorView({ state: cm.EditorState.create({ doc: tab.content, extensions }), parent: host });
                if (tab.line > 0) {
                    const doc = _cmView.state.doc;
                    const lineObj = doc.line(Math.min(Math.max(1, tab.line), doc.lines));
                    _cmView.dispatch({ selection: { anchor: lineObj.from }, scrollIntoView: true });
                }
                return;
            } catch (e) {
                console.error('[coral] CodeMirror editor creation failed:', e);
                _destroyEditor();
            }
        }
        body.innerHTML = `<textarea class="inline-preview-fallback-editor">${escapeHtml(tab.content)}</textarea>`;
        _fallbackEditor = body.querySelector('textarea');
        _fallbackEditor.addEventListener('input', () => {
            const wasDirty = _isDirty(tab);
            tab.content = _fallbackEditor.value;
            if (_isDirty(tab)) tab.pinned = true;
            if (wasDirty !== _isDirty(tab)) _renderTabs();
        });
    }

    async function _mountDiff(tab, body, current) {
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
                const host = _cmHost(body);
                const extensions = [
                    cm.basicSetup, ..._cmTheme(cm), cm.EditorView.lineWrapping,
                    cm.EditorView.editable.of(false), cm.EditorState.readOnly.of(true),
                    cm.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } }),
                    // diffConfig: the merge view's own scanLimit would otherwise return one chunk.
                    // mergeControls off: the view is read-only, so its Accept and Reject buttons would do nothing when clicked.
                    cm.unifiedMergeView({ original: cm.Text.of(tab.originalContent.split('\n')), diffConfig: DIFF_CONFIG, mergeControls: false }),
                ];
                const langExt = getLangExtension(cm, getLangFromPath(tab.filepath));
                if (langExt) extensions.push(langExt);
                _cmView = new cm.EditorView({ state: cm.EditorState.create({ doc: tab.content, extensions }), parent: host });
                return;
            } catch (e) {
                console.error('[coral] CodeMirror merge view creation failed:', e);
                _destroyEditor();
            }
        }
        _renderContentView(body, tab.content, tab.filepath, tab.line, false);
    }
    return { _destroyEditor, _captureEditor, _mountEditor, _mountDiff };
}
