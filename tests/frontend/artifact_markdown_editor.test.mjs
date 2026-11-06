import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
dom.window.eval(fs.readFileSync(STATIC + 'vendor/marked.min.js', 'utf8')); globalThis.marked = dom.window.marked;
dom.window.eval(fs.readFileSync(STATIC + 'vendor/purify.min.js', 'utf8')); globalThis.DOMPurify = dom.window.DOMPurify;
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
const { createMarkdownEditor } = await importUi('artifact_markdown_editor'); const api = await importUi('artifact_markdown_api');
const hex = 'a'.repeat(64), next = 'b'.repeat(64), latest = 'c'.repeat(64);
function setup(source, onSaved = () => {}) {
    const dialog = document.createElement('div'), body = document.createElement('div'), footer = document.createElement('div'); dialog.append(body, footer); document.body.append(dialog); let exited = 0, exitDigest;
    const editor = createMarkdownEditor({ body, footer, dialog, context: api.editContext('local', 'dev', hex), source, onExit: digest => { exited++; exitDigest = digest; }, onSaved });
    return { editor, body, footer, dialog, get exited() { return exited; }, get exitDigest() { return exitDigest; }, close() { editor.destroy(); dialog.remove(); } };
}
const change = (body, oldText, value) => { const node = [...body.querySelectorAll('.amd-text')].find(e => e.textContent === oldText); assert.ok(node); node.textContent = value; node.dispatchEvent(new Event('blur')); };
test('a real editor save posts only the edited source bytes and preserves inline marks/BOM/CRLF', async () => {
    const source = '\ufeff# Keep\r\n\r\nA **careful sentence**.\r\n'; let sent;
    globalThis.fetch = window.fetch = async (url, options) => { sent = { url, ...options }; return Response.json({ digest: "sha256:" + next, id: next, version: 2 }); };
    let done; const saved = new Promise(resolve => { done = resolve; }); const ui = setup(source, done);
    change(ui.body, 'careful sentence', 'revised sentence'); ui.footer.querySelector('.amd-save').click();
    await saved; assert.deepEqual(Buffer.from(sent.body), Buffer.from(source.replace('careful', 'revised'))); assert.equal(ui.editor.dirty, false); ui.close();
});
test('Cancel/leave guard keeps a typed draft until explicit discard, and hidden characters are visible/read-only', () => {
    const ui = setup('Safe words.\n\nHidden\u202e content.\n');
    assert.match(ui.body.textContent, /U\+202E/); assert.equal([...ui.body.querySelectorAll('.amd-text')].some(e => e.textContent.includes('Hidden')), false);
    change(ui.body, 'Safe words.', 'Revised words.'); assert.equal(ui.editor.dirty, true);
    ui.editor.cancel(); assert.equal(ui.exited, 0); document.querySelector('.amd-discard .btn:not(.btn-danger)').click(); assert.equal(ui.editor.dirty, true);
    ui.editor.cancel(); document.querySelector('.amd-discard .btn-danger').click(); assert.equal(ui.exited, 1); ui.close();
});
const observeUntil = (host, predicate) => new Promise(resolve => {
    const observer = new MutationObserver(() => { if (predicate()) { observer.disconnect(); resolve(); } });
    observer.observe(host, { childList: true, subtree: true }); if (predicate()) { observer.disconnect(); resolve(); }
});
test('both stale codes keep drafts and never resend, even when the edited block is unchanged', async () => {
 for(const code of ['stale_version','stale_base']) {
    const base='Old sentence.\n\nOld second block.\n',theirs='Old sentence.\n\nAgent second block.\n';let calls=[];
    globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url,...options});if(options.method!=='POST')return new Response(theirs);if(calls.filter(c=>c.method==='POST').length===1)return Response.json({code,latest_digest:latest,latest_version:2},{status:409});return Response.json({id:next,version:3});};
    let done;const saved=new Promise(r=>{done=r;});const ui=setup(base,done);change(ui.body,'Old sentence.','My sentence.');
    const ready=observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-open-latest'));ui.footer.querySelector('.amd-save').click();await ready;
    assert.equal(ui.body.querySelector('.amd-reapply'),null);assert.equal(calls.filter(c=>c.method==='POST').length,1);
    const opened=observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-kept:not([hidden])'));ui.body.querySelector('.amd-open-latest').click();await opened;
    assert.equal(calls.filter(c=>c.method==='POST').length,1,'opening latest must not save');assert.match(ui.body.querySelector('.amd-kept').textContent,/My sentence/);assert.equal(ui.footer.querySelector('.amd-save').disabled,true);
    change(ui.body,'Old sentence.','My sentence.');ui.footer.querySelector('.amd-save').click();await saved;
    const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.ok(posts[1].url.includes('/artifacts/'+latest+'/edit?expected_latest='+latest));assert.equal(Buffer.from(posts[1].body).toString(),'My sentence.\n\nAgent second block.\n');ui.close();
 }
});
test('a changed edited block is not saved; latest is editable and the old draft stays guarded', async () => {
    let calls=[],saved=0,settled;const reached=new Promise(resolve=>{settled=resolve;});
    globalThis.fetch = window.fetch = async (url,options={})=>{calls.push({url,...options});if(options.method!=='POST')return new Response('Agent sentence.\n\nAgent second block.\n');if(calls.filter(c=>c.method==='POST').length===1)return Response.json({latest_digest:latest,latest_version:2},{status:409});return Response.json({id:next,version:3});};
    const ui=setup('Old sentence.\n\nOld second block.\n',()=>{saved++;settled();});change(ui.body,'Old sentence.','My sentence.');
    const ready=observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-see-theirs'));ui.footer.querySelector('.amd-save').click();await ready;
    observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-kept:not([hidden])')).then(settled);ui.body.querySelector('.amd-open-latest').click();await reached;
    assert.equal(saved,0);assert.equal(calls.filter(c=>c.method==='POST').length,1,'no blind second POST');assert.match(ui.body.querySelector('.amd-kept').textContent,/My sentence/);assert.match(ui.body.querySelector('.amd-document').textContent,/Agent sentence/);
    assert.equal(ui.footer.querySelector('.amd-save').disabled,true);assert.equal(ui.editor.dirty,true,'kept draft is still guarded');ui.editor.cancel();assert.ok(document.querySelector('.amd-discard[open]'));document.querySelector('.amd-discard .btn:not(.btn-danger)').click();ui.editor.cancel();document.querySelector('.amd-discard .btn-danger').click();assert.equal(ui.exited,1);assert.equal(ui.exitDigest,latest,'discard after redo opens the latest baseline, not the stale version');ui.close();
});

test('Save enables for unblurred native-style input and commits it before sending', async () => {
    let sent; globalThis.fetch = window.fetch = async (url, options) => { sent = options; return Response.json({ digest: next, version: 2 }); };
    let done; const saved = new Promise(resolve => { done = resolve; }); const ui = setup('Original words.\n', done);
    const span = ui.body.querySelector('.amd-text'); span.focus(); span.textContent = 'New words.'; span.dispatchEvent(new Event('input'));
    assert.equal(ui.footer.querySelector('.amd-save').disabled, false);
    ui.footer.querySelector('.amd-save').click(); await saved;
    assert.equal(Buffer.from(sent.body).toString(), 'New words.\n'); ui.close();
});

test('plain-text paste enables Save immediately and preserves source delimiters', async () => {
    let sent; globalThis.fetch = window.fetch = async (url, options) => { sent = options; return Response.json({ digest: next, version: 2 }); };
    let done; const saved = new Promise(resolve => { done = resolve; }); const ui = setup('A **word**.\n', done);
    const span = [...ui.body.querySelectorAll('.amd-text')].find(e => e.textContent === 'word'); span.focus();
    const range = document.createRange(); range.selectNodeContents(span); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const paste = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'replacement' } }); span.dispatchEvent(paste);
    assert.equal(ui.footer.querySelector('.amd-save').disabled, false); ui.footer.querySelector('.amd-save').click(); await saved;
    assert.equal(Buffer.from(sent.body).toString(), 'A **replacement**.\n'); ui.close();
});

test('nested list editing preserves markers and permits a literal continuation without adding an item',async()=>{
 const source='\ufeff- Parent\r\n  - Nested words\r\n- Last words\r\n';let sent;let done;const saved=new Promise(r=>{done=r;});
 globalThis.fetch=window.fetch=async(u,o)=>{sent=o.body;return Response.json({id:next,version:2});};
 const ui=setup(source,done);change(ui.body,'Nested words','Revised words\n- literal');
 assert.equal(ui.footer.querySelector('.amd-save').disabled,false);assert.equal(ui.body.querySelectorAll('li').length,3);
 ui.footer.querySelector('.amd-save').click();await saved;assert.equal(Buffer.from(sent).toString(),source.replace('Nested words','Revised words\r\n    \\- literal'));ui.close();
});

test('a multiline plain-text paste into a list retains the same items',()=>{
 const ui=setup('- First words\n  - Nested words\n- Last words\n');const span=[...ui.body.querySelectorAll('.amd-text')].find(e=>e.textContent==='Nested words');assert.ok(span);assert.equal(span.getAttribute('aria-multiline'),'true','Enter continues this textbox');span.focus();const range=document.createRange();range.selectNodeContents(span);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
 const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> 'New words\n1. literal'}});span.dispatchEvent(paste);assert.equal(span.textContent,'New words\n1. literal');span.blur();assert.equal(ui.body.querySelectorAll('li').length,3);assert.equal(ui.footer.querySelector('.amd-save').disabled,false);ui.close();
});

test('table edits escape typed pipes and reject a pasted row break',async()=>{
 const source='\ufeff| Item | Owner |\r\n|---|---|\r\n| Report | Operator |\r\n';let sent;let done;const saved=new Promise(r=>{done=r;});globalThis.fetch=window.fetch=async(u,o)=>{sent=o.body;return Response.json({id:next,version:2});};const ui=setup(source,done);
 const span=[...ui.body.querySelectorAll('.amd-text')].find(e=>e.textContent==='Operator');assert.ok(span);assert.equal(span.getAttribute('aria-multiline'),null);span.focus();const range=document.createRange();range.selectNodeContents(span);getSelection().removeAllRanges();getSelection().addRange(range);const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> 'New\nRow'}});span.dispatchEvent(paste);assert.equal(span.textContent,'Operator');
 change(ui.body,'Operator','New | Owner');assert.equal(ui.body.querySelectorAll('td').length,2);ui.footer.querySelector('.amd-save').click();await saved;assert.equal(Buffer.from(sent).toString(),source.replace('Operator','New \\| Owner'));ui.close();
});

test('table drafts survive either stale refusal without an automatic second POST',async()=>{
 for(const code of ['stale_version','stale_base']){
  const source='| Item | Owner |\n|---|---|\n| Report | Operator |\n',theirs=source.replace('Operator','Agent');let posts=0;
  globalThis.fetch=window.fetch=async(u,o={})=>{if(o.method==='POST'){posts++;return Response.json({code,latest_digest:latest,latest_version:2},{status:409});}return new Response(theirs);};const ui=setup(source);change(ui.body,'Operator','My words');const ready=observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-open-latest'));ui.footer.querySelector('.amd-save').click();await ready;
  const opened=observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-kept:not([hidden])'));ui.body.querySelector('.amd-open-latest').click();await opened;assert.equal(posts,1);assert.match(ui.body.querySelector('.amd-kept').textContent,/My words/);assert.match(ui.body.querySelector('.amd-document').textContent,/Agent/);assert.equal(ui.footer.querySelector('.amd-save').disabled,true);ui.close();
 }
});
