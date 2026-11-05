import { analyze, mapRenderedBlock, editRun, bytePatch, MAX_BYTES } from './model.mjs';
import { renderMarkdownStrict } from '../../../coral-go/pkg/frontend/static/markdown.js';
const $ = id => document.getElementById(id);
const sample = JSON.parse($('report-copy').textContent);
const examples = '\ufeff---\r\ntitle: A source-preserving note\r\n---\r\n\r\n# A report worth keeping\r\n\r\nThe **careful wording** and [review link](https://example.com/review) stay in place. A `small code span` keeps its marks.\r\n\r\n- Change this sentence without touching the list marker.\r\n- The other item keeps every original byte.\r\n\r\n| Read-only table | Status |\r\n| --- | --- |\r\n| Do not rewrite | Kept |\r\n\r\n```js\r\nconst unchanged = true;\r\n```\r\n\r\n<div>Raw HTML is read-only and escaped.</div>\r\n\r\nA &amp; B and \\*escaped marks\\* are a conservative read-only fallback.\r\n\r\n![Read-only image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPfoAAAAASUVORK5CYII=)\r\n';
let original = sample.source, source = original, name = sample.name, editing = false, dirty = false, composing = false;
function say(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function structure(element) { return [...element.querySelectorAll('*')].map(e => [e.tagName, e.getAttribute('href'), e.getAttribute('src')]); }
function rendered(raw, references) {
    const template = document.createElement('template'); template.innerHTML = renderMarkdownStrict(raw + (references ? '\n\n' + references : ''));
    // Keep the offline demo offline: remote/file images stay as labelled placeholders.
    for (const image of template.content.querySelectorAll('img')) if (!/^data:image\//i.test(image.getAttribute('src') || '')) { image.removeAttribute('src'); image.title = 'Image · read-only; not loaded in the offline prototype'; }
    const e = document.createElement('div'); e.append(template.content); return e;
}
function updateDiff() {
    const patch = bytePatch(original, source); $('changes').hidden = !dirty;
    $('change-count').textContent = dirty ? `${patch.removedBytes} bytes replaced with ${patch.insertedBytes}; ${patch.unchangedPrefixBytes + patch.unchangedSuffixBytes} outer bytes unchanged.` : 'No changes yet.';
    const a = Array.from(original), b = Array.from(source); let i = 0, j = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    $('before').textContent = a.slice(i, a.length - j).join('') || '(nothing)';
    $('after').textContent = b.slice(i, b.length - j).join('') || '(nothing)';
    $('reset').disabled = !dirty; $('review-changes').hidden = !dirty;
}
function draw() {
    const model = analyze(source, window.marked); const article = $('document'); article.replaceChildren(); let exact = 0, eligible = 0, total = 0;
    for (const block of model.blocks) {
        const section = document.createElement('section'), body = rendered(block.raw, model.references); body.className = 'prose'; section.className = 'block';
        const map = block.reason ? { exact: false, entries: [] } : mapRenderedBlock(block, body);
        const canEdit = map.exact && map.entries.some(e => e.run.editable); total++;
        eligible += block.unitCount; if (map.exact) exact += block.units.filter(u => block.runs.slice(u.first, u.first + u.count).length > 0 && block.runs.slice(u.first, u.first + u.count).every(r => r.editable)).length;
        if (canEdit) {
            section.classList.add('editable-block');
            for (const { node, run } of map.entries) {
                if (!run.editable) continue;
                const span = document.createElement('span'); span.className = 'text-run'; span.textContent = node.data; span.dataset.editRun = '';
                if (editing) { span.contentEditable = 'plaintext-only'; span.setAttribute('role', 'textbox'); span.setAttribute('aria-label', 'Edit rendered text'); span.tabIndex = 0; span.spellcheck = true; }
                node.replaceWith(span); let before = span.textContent;
                span.addEventListener('compositionstart', () => { composing = true; }); span.addEventListener('compositionend', () => { composing = false; });
                span.addEventListener('paste', event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (/[\r\n]/.test(text)) { say('Paste words within one text run; line breaks are read-only.', true); return; } const selection = window.getSelection(); if (!selection.rangeCount) return; const range = selection.getRangeAt(0); if (!span.contains(range.commonAncestorContainer)) return; range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); });
                span.addEventListener('beforeinput', event => { if (['insertParagraph', 'insertLineBreak', 'insertFromDrop'].includes(event.inputType)) { event.preventDefault(); say('Text only: paragraph boundaries and formatting stay in place.'); } });
                span.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); span.textContent = before; span.blur(); } else if (event.key === 'Enter' && !composing && !event.isComposing) { event.preventDefault(); span.blur(); } });
                span.addEventListener('blur', event => {
                    const nextIndex = event.relatedTarget?.matches?.('[data-edit-run]') ? [...article.querySelectorAll('[data-edit-run]')].indexOf(event.relatedTarget) : -1;
                    if (span.textContent === before) return;
                    try {
                        const changed = editRun(source, run, span.textContent);
                        const newRaw = changed.source.slice(block.start, block.end + changed.source.length - source.length);
                        const check = rendered(newRaw, model.references), prior = rendered(block.raw, model.references);
                        if (JSON.stringify(structure(check)) !== JSON.stringify(structure(prior)) || check.textContent !== body.textContent) throw new Error('That edit changes Markdown structure or text normalization; it stays read-only.');
                        source = changed.source; dirty = source !== original; draw(); if (nextIndex >= 0) article.querySelectorAll('[data-edit-run]')[nextIndex]?.focus(); say('Words changed in this page only. No file or version has been saved.');
                    } catch (error) { span.textContent = before; say(error.message, true); }
                });
            }
        } else {
            section.classList.add('read-only'); const label = document.createElement('span'); label.className = 'read-only-label'; label.textContent = `${block.reason || (body.querySelector('img') ? 'Image' : 'Exact text mapping unavailable')} · read-only`; section.append(label);
        }
        section.append(body); article.append(section);
    }
    $('doc-name').textContent = name; $('coverage').textContent = `${exact} of ${eligible} paragraph, heading and list-item blocks map exactly · ${total} rendered sections`;
    $('edit').textContent = editing ? 'Finish editing' : 'Edit text'; $('edit').setAttribute('aria-pressed', String(editing)); article.classList.toggle('editing', editing); updateDiff();
}
$('edit').addEventListener('click', () => { editing = !editing; draw(); say(editing ? 'Click or Tab to a highlighted text run. Enter applies; Escape cancels. Formatting stays in place.' : 'Reading view. Your changes remain in this page only.'); });
$('review-changes').addEventListener('click', () => { $('changes').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('changes').focus({ preventScroll: true }); });
$('reset').addEventListener('click', () => { source = original; dirty = false; draw(); say('Original bytes restored.'); });
$('choose').addEventListener('change', () => { source = original = $('choose').value === 'report' ? sample.source : examples; name = $('choose').value === 'report' ? sample.name : 'Formatting and CRLF examples'; dirty = false; draw(); say('Read-only source copy loaded. Nothing is saved to Coral.'); });
$('file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > MAX_BYTES) throw new Error('Choose a Markdown file no larger than 2 MiB.'); if (!/\.(md|markdown|mdown)$/i.test(file.name)) throw new Error('Choose a Markdown file.'); original = source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); name = file.name; dirty = false; draw(); say('Local copy loaded into memory. No upload or save request was made.'); } catch (error) { say(error.message, true); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
$('document').addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); });
// Prototype test hooks contain memory only, not credentials, upload functions or network clients.
window.__markdownPrototype = { get source() { return source; }, get original() { return original; }, analyze: () => analyze(source, window.marked), bytePatch: () => bytePatch(original, source) };
draw(); say('A real agent report, copied for this prototype. Edit words without opening a source view.');
