import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
dom.window.eval(fs.readFileSync(STATIC + 'vendor/marked.min.js','utf8')); globalThis.marked = dom.window.marked;
dom.window.eval(fs.readFileSync(STATIC + 'vendor/purify.min.js','utf8')); globalThis.DOMPurify = dom.window.DOMPurify;
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
const hex = 'a'.repeat(64), other = 'b'.repeat(64); let allowed = true, stalled = null;
globalThis.fetch = window.fetch = async url => {
    const path = new URL(String(url), location.href).pathname;
    if (path.endsWith('/edit')) { if (stalled) await stalled; return Response.json({ can_edit: allowed, latest_digest: hex, version: 1 }); }
    if (/\/api\/artifacts\/[a-f0-9]{64}$/.test(path)) return new Response('\ufeff# Document\r\n\r\nAn original sentence.\r\n', { headers: { 'Content-Type':'text/markdown', 'Content-Disposition':'attachment; filename="report.md"' } });
    return new Response('', { status:404 });
};
const viewer = await importUi('artifact_viewer');
function until(predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise(resolve => { const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(); } }); observer.observe(document.body,{subtree:true,attributes:true,childList:true}); });
}
test('only the server owner capability exposes Edit; opening/cancelling retains exact document context', async () => {
    viewer.openArtifactViewer(hex,{board:'dev',server:'local',filename:'report.md'});
    await until(() => document.querySelector('.artifact-viewer-edit') && !document.querySelector('.artifact-viewer-edit').hidden);
    document.querySelector('.artifact-viewer-edit').click(); await until(() => !!document.querySelector('.amd-text'));
    assert.equal(document.querySelector('.artifact-viewer-close').closest('#artifact-viewer').classList.contains('av-markdown-edit'),true);
    const span=[...document.querySelectorAll('.amd-text')].find(e=>e.textContent==='An original sentence.'); span.textContent='A changed sentence.';span.dispatchEvent(new Event('blur'));
    document.querySelector('.amd-cancel').click(); assert.ok(document.querySelector('.amd-discard[open]'));
    document.querySelector('.amd-discard .btn:not(.btn-danger)').click(); assert.ok(document.querySelector('.amd-editor'));
    document.querySelector('.amd-cancel').click();document.querySelector('.amd-discard .btn-danger').click();
    assert.equal(document.querySelector('.amd-editor'),null);assert.match(document.querySelector('.artifact-viewer-body').textContent,/An original sentence/);assert.equal(document.querySelector('.artifact-viewer-markdown h1')?.textContent,'Document','Cancel restores the BOM-backed document as the same rendered heading');
    document.querySelector('.artifact-viewer-close').click();
});
test('a late permission response cannot expose Edit on the next document', async () => {
    let release; stalled=new Promise(resolve=>{release=resolve;});
    viewer.openArtifactViewer(hex,{board:'dev',server:'local',filename:'report.md'});
    await until(()=>/An original sentence/.test(document.querySelector('.artifact-viewer-body')?.textContent||''));
    viewer.openArtifactViewer(other,{board:'dev',server:'local',filename:'plain.txt',mediaType:'text/plain'});
    allowed=false;stalled=null;release();
    await until(()=>/An original sentence/.test(document.querySelector('.artifact-viewer-body')?.textContent||''));
    assert.equal(document.querySelector('.artifact-viewer-edit').hidden,true);
    document.querySelector('.artifact-viewer-close').click();
});
