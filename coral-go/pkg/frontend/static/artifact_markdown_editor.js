/* Text-only editing on the rendered file. Nothing serializes Markdown: each accepted
 * change splices one verified source range, then re-maps the new immutable string. */
import { importOnce } from './import_once.js';
import { renderMarkdownStrict } from './utils.js';
import { el } from './dom_el.js';
import { loadStyles } from './lazy_styles.js';
const M = await importOnce('./artifact_markdown_model.js');
const API = await importOnce('./artifact_markdown_api.js');
await loadStyles('artifact_markdown_editor.css');
const makeButton = (text, cls, fn) => { const b = el('button', 'btn ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
const HEX = /^[a-f0-9]{64}$/;
const shape = element => [...element.querySelectorAll('*')].map(e => [e.tagName, e.getAttribute('href'), e.getAttribute('src')]);
function render(raw, references) {
    const body = el('div', 'prose prose-doc amd-prose');
    body.innerHTML = renderMarkdownStrict(raw + (references ? '\n\n' + references : ''));
    if (body.querySelector('table')) body.classList.add('md');
    return body;
}
function showSpecials(host) {
    const walker = document.createTreeWalker(host, 4), nodes = [];
    while (walker.nextNode()) if (M.HIDDEN.test(walker.currentNode.data)) nodes.push(walker.currentNode);
    for (const node of nodes) { const visible = el('span', 'amd-specials', M.visibleSpecials(node.data)); visible.title = 'Hidden or bidirectional characters are shown by code point; this block stays read-only.'; node.replaceWith(visible); }
}
/** Returns { cancel, beforeLeave(next), destroy, dirty, busy }. onExit restores the
 * rendered original; onSaved opens the server's newly stored version. */
export function createMarkdownEditor({ body, footer, dialog, context, source: initialSource, onExit, onSaved }) {
    let source = initialSource, original = initialSource, busy = false, dead = false, composing = false, confirmOpen = false, latest = null, pendingText = false, baseDigest = context.hex;
    let mode = 'rendered', previewShown = false;
    const keptDrafts = [];
    const status = el('p', 'amd-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const hint = el('p', 'amd-hint', 'Edit words in the highlighted text. Enter adds a line where supported or applies a change elsewhere; Escape cancels it. Formatting and read-only blocks stay in place.');
    const documentHost = el('div', 'amd-document'), conflict = el('section', 'amd-conflict'); conflict.hidden = true; conflict.setAttribute('aria-label', 'A newer document version');
    const kept = el('section', 'amd-kept'); kept.hidden = true; kept.setAttribute('aria-label', 'Your unsaved drafts');
    const modes=el('div','amd-modes');modes.setAttribute('role','group');modes.setAttribute('aria-label','Editing mode');
    const renderedButton=makeButton('Rendered text','amd-mode-rendered',()=>switchMode('rendered'));
    const rawButton=makeButton('Raw text','amd-mode-raw',()=>switchMode('raw'));
    const previewButton=makeButton('Preview','amd-preview-toggle',()=>{previewShown=!previewShown;draw();});modes.append(renderedButton,rawButton,previewButton);
    const wrapper = el('div', 'amd-editor'); wrapper.append(modes, hint, status, conflict, documentHost, kept);
    const cancelButton = makeButton('Cancel', 'amd-cancel', () => cancel());
    const saveButton = makeButton('Save as new version', 'btn-primary amd-save', () => save(baseDigest));
    footer.prepend(cancelButton, saveButton); dialog.classList.add('av-markdown-edit'); body.replaceChildren(wrapper);
    const say = (text, error = false) => { status.textContent = text; status.classList.toggle('is-error', error); };
    const sync = () => { saveButton.disabled = busy || !!latest || (!pendingText && source === original); cancelButton.disabled = busy; documentHost.inert = busy; modes.inert = busy; };
    const flush = () => { if (documentHost.contains(document.activeElement)) document.activeElement.blur(); };
    const beforeLeave = next => {
        flush(); if (dead) return false;
        if (busy) { say('The version is being saved. Wait for its result before leaving.'); return true; }
        if (source === original && !keptDrafts.length) return false;
        if (confirmOpen) return true;
        confirmOpen = true;
        const prompt = el('dialog', 'dlg-confirm amd-discard'), title = el('h2', null, 'Discard your text changes?'); title.id = 'amd-discard-title'; prompt.setAttribute('aria-labelledby', title.id);
        const words = el('p', null, 'Your changes have not been saved as a new version.');
        const actions = el('div', 'modal-actions'), keep = makeButton('Keep editing', '', () => prompt.close());
        const discard = makeButton('Discard changes', 'btn-danger', () => { source = original; keptDrafts.length = 0; prompt.close(); next(); });
        actions.append(keep, discard); prompt.append(title, words, actions); document.body.append(prompt);
        prompt.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
        prompt.addEventListener('close', () => { confirmOpen = false; prompt.remove(); if (!dead) { if (!saveButton.disabled) saveButton.focus(); else documentHost.querySelector('.amd-text')?.focus(); } }, { once: true });
        prompt.showModal(); keep.focus(); return true;
    };
    const exit = () => onExit(baseDigest);
    const cancel = () => { if (!beforeLeave(exit)) exit(); };
    function switchMode(next) {flush();if(dead||busy||mode===next)return;mode=next;draw();documentHost.querySelector('.amd-raw,.amd-text')?.focus();}
    function draw() {
        if (dead) return;
        renderedButton.setAttribute('aria-pressed',String(mode==='rendered'));rawButton.setAttribute('aria-pressed',String(mode==='raw'));
        previewButton.hidden=mode!=='raw';previewButton.setAttribute('aria-pressed',String(previewShown));
        documentHost.replaceChildren();
        if(mode==='raw') {
            hint.textContent='Edit the whole Markdown file. Preview shows how it will render. Save creates a new version.';
            const input=el('textarea','amd-raw');input.setAttribute('aria-label','Markdown source');input.spellcheck=false;input.value=M.normalizeSource(source).text;
            const warning=el('p','amd-raw-warning');warning.setAttribute('role','status');
            const preview=el('div','amd-preview');preview.hidden=!previewShown;
            const update=()=>{warning.hidden=!M.HIDDEN.test(M.normalizeSource(source).text);warning.textContent=warning.hidden?'':'This source contains hidden or bidirectional characters. They are preserved in the file.';if(previewShown){preview.replaceChildren(wholeDocument(source));}};
            input.addEventListener('input',()=>{source=M.editRaw(source,input.value);pendingText=false;update();sync();});
            documentHost.append(input,warning,preview);update();sync();return;
        }
        hint.textContent='Edit words in the highlighted text. Enter adds a line where supported or applies a change elsewhere; Escape cancels it. Formatting and read-only blocks stay in place.';
        let model;
        try {model=M.analyze(source,marked);} catch(error) {documentHost.append(el('p','amd-readonly',error.message+' Use Raw text to continue editing.'));if(new TextEncoder().encode(source).length<=M.MAX_BYTES)documentHost.append(wholeDocument(source));sync();return;}

        for (const block of model.blocks) {
            const section = el('section', 'amd-block'), prose = render(block.raw, model.references);
            const map = block.reason ? { exact: false, entries: [] } : M.mapRenderedBlock(block, prose);
            const editable = map.exact && map.entries.some(e => e.run.editable);
            if (!editable) {
                // A hidden character may live in a destination/attribute, outside text nodes.
                const hidden = new Set(); if (M.HIDDEN.test(block.raw)) for (const char of block.raw) if (M.HIDDEN.test(char)) hidden.add(char);
                const codes = [...hidden].map(char => M.visibleSpecials(char)).join(' ');
                const label = el('p', 'amd-readonly', `${block.reason || (prose.querySelector('img') ? 'Image' : 'Text mapping unavailable')}${codes ? ' ' + codes : ''} — read-only`); section.append(label); showSpecials(prose);
            } else {
                for (const { node, run } of map.entries) {
                    if (!run.editable) continue;
                    const span = el('span', 'amd-text', node.data); span.contentEditable = 'plaintext-only'; span.setAttribute('role', 'textbox'); span.setAttribute('aria-label', 'Edit document text'); if (run.newlinePrefix != null) span.setAttribute('aria-multiline', 'true'); span.tabIndex = 0; span.spellcheck = true; node.replaceWith(span);
                    const before = span.textContent;
                    span.addEventListener('input', () => { pendingText = span.textContent !== before; sync(); });
                    span.addEventListener('compositionstart', () => { composing = true; }); span.addEventListener('compositionend', () => { composing = false; });
                    const insertPlain = text => {
                        const selection = getSelection(); if (!selection.rangeCount) return;
                        const range = selection.getRangeAt(0); if (!span.contains(range.commonAncestorContainer)) return;
                        range.deleteContents(); const textNode = document.createTextNode(text); range.insertNode(textNode);
                        // Chrome needs a trailing placeholder to keep a caret after a final newline.
                        if (span.textContent.endsWith('\n') && !span.querySelector('[data-amd-caret]')) { const br=document.createElement('br'); br.dataset.amdCaret=''; span.append(br); }
                        range.setStartAfter(textNode); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); pendingText = span.textContent !== before; sync();
                    };
                    span.addEventListener('beforeinput', event => {
                        const line = ['insertParagraph','insertLineBreak'].includes(event.inputType);
                        if ((line && run.newlinePrefix == null) || event.inputType === 'insertFromDrop' || M.HIDDEN.test(event.data || '')) { event.preventDefault(); say('Use plain words without hidden characters; structural markers stay unchanged.', true); return; }
                        if (event.inputType === 'insertText' && /[\r\n]/.test(event.data || '')) { event.preventDefault(); if (run.newlinePrefix != null) insertPlain(event.data.replace(/\r\n?/g,'\n')); else say('Edit words within one text run; changing line breaks is not supported.', true); return; }
                        if (line && run.newlinePrefix != null) { event.preventDefault(); insertPlain('\n'); return; }

                    });
                    span.addEventListener('paste', event => {
                        event.preventDefault(); const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n');
                        if ((/[\r\n]/.test(text) && run.newlinePrefix == null) || M.HIDDEN.test(text)) { say('Paste words without line breaks or hidden characters.', true); return; }
                        insertPlain(text);
                    });
                    span.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); span.textContent = before; span.blur(); } else if (event.key === 'Enter' && !composing && !event.isComposing) { event.preventDefault(); event.stopPropagation(); if (run.newlinePrefix != null) insertPlain('\n'); else span.blur(); } });
                    span.addEventListener('blur', event => {
                        pendingText = false;
                        if (span.textContent === before || dead) { sync(); return; }
                        const nextIndex = event.relatedTarget?.matches?.('.amd-text') ? [...documentHost.querySelectorAll('.amd-text')].indexOf(event.relatedTarget) : -1;
                        const previousSource = source;
                        try {
                            const changed = M.editRun(source, run, span.textContent), raw = changed.source.slice(block.start, block.end + changed.source.length - source.length);
                            const next = render(raw, model.references), previous = render(block.raw, model.references);
                            if (JSON.stringify(shape(next)) !== JSON.stringify(shape(previous)) || next.textContent !== prose.textContent) throw new Error('That change affects Markdown structure. Edit the words within one highlighted run.');
                            source = changed.source; draw(); if (nextIndex >= 0) documentHost.querySelectorAll('.amd-text')[nextIndex]?.focus();
                            say(source === original ? 'No text changes.' : 'Text changed. Save as a new version when ready.');
                        } catch (error) { source = previousSource; if (span.isConnected) span.textContent = before; else draw(); sync(); say(error.message, true); }
                    });
                }
            }
            section.append(prose); documentHost.append(section);
        }
        sync();
    }
    function wholeDocument(text) {
        const prose = render(text.replace(/^\ufeff/, ''), ''); showSpecials(prose); return prose;
    }
    function keepDraft() {
        if (!keptDrafts.includes(source)) keptDrafts.push(source);
        kept.hidden = false; kept.replaceChildren(el('h3', null, 'Your unsaved draft'), el('p', null, 'Your words are kept here. Redo your edits in the latest version above; nothing was saved.'));
        for (const draft of keptDrafts) {
            if(mode==='raw'){const copy=el('textarea','amd-kept-source');copy.readOnly=true;copy.setAttribute('aria-label','Your unsaved Markdown source');copy.value=draft;kept.append(copy);}else kept.append(wholeDocument(draft));
        }
    }
    async function showTheirs() {
        const choice = latest; if (!choice || dead) return;
        try {
            const text = await API.readEditSource({ ...context, hex: choice.digest }); if (dead || latest !== choice) return;
            conflict.querySelector('.amd-theirs')?.remove(); const theirs = el('div', 'amd-theirs'), heading = el('h3', null, `Latest saved version${choice.version ? ' ' + choice.version : ''}`);
            theirs.append(heading, makeButton('Hide latest version', 'btn-small', () => theirs.remove()), wholeDocument(text)); conflict.append(theirs);
            heading.tabIndex = -1; heading.focus();
        } catch (error) { if (!dead) say(error.message || 'The latest version could not be read.', true); }
    }
    async function openLatest() {
        flush(); const choice = latest; if (!choice || dead || busy) return;
        let opened = false;
        busy = true; sync(); conflict.querySelectorAll('button').forEach(b => { b.disabled = true; }); say('Reading the latest version; your draft will be kept…');
        try {
            const theirs = await API.readEditSource({ ...context, hex: choice.digest }); if (dead || latest !== choice) return;
            keepDraft(); original = theirs; source = theirs; baseDigest = choice.digest;
            latest = null; conflict.hidden = true; conflict.replaceChildren(); draw();
            say('The latest version is open. Nothing was saved. Your old draft is kept below; redo your changes here before saving.', true);
            opened = true;
        } catch (error) { if (!dead) say(error.message || 'The latest version could not be opened. Your draft is kept.', true); }
        finally { busy = false; if (!dead) { sync(); conflict.querySelectorAll('button').forEach(b => { b.disabled = false; }); } }
        if (opened && !dead) documentHost.querySelector('.amd-raw,.amd-text')?.focus();
    }
    function showConflict(data) {
        const digest = data.latest_digest || data.latest?.digest;
        if (!HEX.test(String(digest))) { say('A newer version exists. Reload it before saving your changes.', true); return; }
        latest = { digest, version: data.latest_version || data.latest?.version || data.version };
        const title = el('h3', null, 'A newer version was saved'), words = el('p', null, 'Nothing was saved. Your draft is still here. Open the latest version and redo your changes; there is no override or automatic retry.');
        conflict.replaceChildren(title, words, makeButton('See theirs', 'amd-see-theirs', showTheirs), makeButton('Open latest and keep draft', 'amd-open-latest', openLatest));
        conflict.hidden = false; title.tabIndex = -1; title.focus();
    }
    async function save(expected) {
        flush(); if (dead || busy || latest || source === original) return;
        busy = true; sync(); conflict.querySelectorAll('button').forEach(b => { b.disabled = true; }); say('Saving a new version…');
        try {
            const saved = await API.saveMarkdown({ ...context, hex: baseDigest }, source, expected);
            if (dead) return;
            const digest = String(saved.id || saved.hex || saved.digest || '').replace(/^sha256:/, '');
            if (!HEX.test(String(digest))) throw new Error('The save result could not be confirmed. Check the latest version before trying again.');
            original = source; keptDrafts.length = 0; busy = false; sync(); onSaved({ ...saved, digest });
        } catch (error) {
            if (dead) return;
            if (error.status === 409) showConflict(error.data || {});
            else say(error.status || error.preflight ? error.message : `${error.message || 'The save result could not be confirmed.'} Your draft is kept. Check the latest version before retrying.`, true);
        } finally { busy = false; if (!dead) { sync(); conflict.querySelectorAll('button').forEach(b => { b.disabled = false; }); } }
    }
    const unload = event => { if (source !== original || keptDrafts.length || pendingText || busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    // Do not follow document links while selecting/editing their words.
    const link = event => { if (event.target.closest('a')) event.preventDefault(); }; wrapper.addEventListener('click', link);
    draw(); say('Editing this version. Changes are saved only when you choose Save as a new version.'); documentHost.querySelector('.amd-text')?.focus();
    return { cancel, beforeLeave, get dirty() { flush(); return source !== original || keptDrafts.length > 0; }, get busy() { return busy; }, destroy() { dead = true; window.removeEventListener('beforeunload', unload); cancelButton.remove(); saveButton.remove(); dialog.classList.remove('av-markdown-edit'); wrapper.remove(); document.querySelector('.amd-discard')?.close(); } };
}
