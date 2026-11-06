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
function setup(source, onSaved = () => {}, contextOverride = null) {
    const dialog = document.createElement('div'), body = document.createElement('div'), footer = document.createElement('div'); dialog.append(body, footer); document.body.append(dialog); let exited = 0, exitDigest;
    const editor = createMarkdownEditor({ body, footer, dialog, context: contextOverride || api.editContext('local', 'dev', hex), source, onExit: digest => { exited++; exitDigest = digest; }, onSaved });
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

test('code body edits remain literal, save exact source, and reject a closing fence',async()=>{
 const source='\ufeff```bash\r\nprintf old\r\n```\r\n';let sent;globalThis.fetch=window.fetch=async(url,options)=>{sent=options.body;return Response.json({id:next,version:2});};let done;const saved=new Promise(r=>{done=r;});const ui=setup(source,done);
 const field=ui.body.querySelector('pre .amd-text');assert.ok(field);assert.equal(field.getAttribute('aria-multiline'),'true');
 change(ui.body,'printf old','printf old\n```');assert.equal(ui.body.querySelector('pre .amd-text').textContent,'printf old');assert.equal(ui.editor.dirty,false);
 change(ui.body,'printf old','printf new\n<b>literal</b>');assert.equal(ui.body.querySelectorAll('pre').length,1);assert.equal(ui.body.querySelector('b'),null);ui.footer.querySelector('.amd-save').click();await saved;
 assert.equal(Buffer.from(sent).toString(),source.replace('printf old','printf new\r\n<b>literal</b>'));ui.close();
});

test('code drafts survive both stale refusals without resend',async()=>{
 for(const code of ['stale_version','stale_base']) {
  const source='```bash\nold words\n```\n',theirs=source.replace('old','agent');let posts=0;globalThis.fetch=window.fetch=async(url,options={})=>{if(options.method==='POST'){posts++;return Response.json({code,latest_digest:latest,latest_version:2},{status:409});}return new Response(theirs);};
  const ui=setup(source);change(ui.body,'old words','my words');ui.footer.querySelector('.amd-save').click();await observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-open-latest'));ui.body.querySelector('.amd-open-latest').click();await observeUntil(ui.body,()=>!ui.body.querySelector('.amd-kept').hidden);
  assert.equal(posts,1);assert.match(ui.body.querySelector('.amd-kept').textContent,/my words/);assert.equal(ui.footer.querySelector('.amd-save').disabled,true);assert.equal(ui.body.querySelector('.amd-reapply,.amd-save-after'),null);ui.close();
 }
});

test('quote editing inserts a literal continuation inside the original quote',async()=>{
 const source='\ufeff> Quoted words\r\n\r\nOutside.\r\n';let sent;globalThis.fetch=window.fetch=async(url,options)=>{sent=options.body;return Response.json({id:next,version:2});};let done;const saved=new Promise(r=>{done=r;});const ui=setup(source,done);
 assert.equal(ui.body.querySelector('blockquote .amd-text').getAttribute('aria-multiline'),'true');change(ui.body,'Quoted words','Revised words\n> literal');assert.equal(ui.body.querySelectorAll('blockquote').length,1);ui.footer.querySelector('.amd-save').click();await saved;assert.equal(Buffer.from(sent).toString(),source.replace('Quoted words','Revised words\r\n> \\> literal'));ui.close();
});

test('quote drafts survive both stale refusals without resend',async()=>{
 for(const code of ['stale_version','stale_base']) {
  const source='> old words\n',theirs=source.replace('old','agent');let posts=0;globalThis.fetch=window.fetch=async(url,options={})=>{if(options.method==='POST'){posts++;return Response.json({code,latest_digest:latest,latest_version:2},{status:409});}return new Response(theirs);};
  const ui=setup(source);change(ui.body,'old words','my words');ui.footer.querySelector('.amd-save').click();await observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-open-latest'));ui.body.querySelector('.amd-open-latest').click();await observeUntil(ui.body,()=>!ui.body.querySelector('.amd-kept').hidden);assert.equal(posts,1);assert.match(ui.body.querySelector('.amd-kept').textContent,/my words/);assert.equal(ui.footer.querySelector('.amd-save').disabled,true);ui.close();
 }
});

test('raw editing changes structure through plain text, uses strict preview, and saves exact bytes',async()=>{
 const source='\ufeff# Old\r\n\r\nKeep.\r\n';let sent;globalThis.fetch=window.fetch=async(url,options)=>{sent=options.body;return Response.json({id:next,version:2});};let done;const saved=new Promise(r=>{done=r;});const ui=setup(source,done);
 assert.ok(ui.body.querySelector('.amd-mode-raw'));ui.body.querySelector('.amd-mode-raw').click();const text=ui.body.querySelector('.amd-raw');assert.equal(text.value,'# Old\n\nKeep.\n');
 const inserted='<script>window.BAD=1</script>\n[bad](javascript:alert(1))\n![remote](https://example.com/x.png)\n[local](coral://artifacts/'+hex+')\n\u202e';text.value=text.value.replace('Keep.',inserted);text.dispatchEvent(new Event('input'));
 assert.match(ui.body.querySelector('.amd-raw-warning').textContent,/bidirectional/);ui.body.querySelector('.amd-preview-toggle').click();const preview=ui.body.querySelector('.amd-preview');assert.equal(preview.querySelector('script'),null);assert.ok(preview.textContent.includes('<script>'));assert.equal(preview.querySelector('[href^="javascript:"],img[src^="https:"]'),null);assert.ok(preview.querySelector('[href^="coral:"]'));
 ui.body.querySelector('.amd-mode-rendered').click();assert.ok(ui.body.textContent.includes('<script>'));ui.body.querySelector('.amd-mode-raw').click();assert.ok(ui.body.querySelector('.amd-raw').value.includes(inserted));ui.footer.querySelector('.amd-save').click();await saved;assert.equal(Buffer.from(sent).toString(),source.replace('Keep.',inserted.replace(/\n/g,'\r\n')));ui.close();
});

test('raw mode retains the exact draft after either stale refusal and never auto-posts',async()=>{
 for(const code of ['stale_version','stale_base']) {
  const source='\ufeff# Old\r\n',theirs='# Agent\r\n';let posts=0;globalThis.fetch=window.fetch=async(url,options={})=>{if(options.method==='POST'){posts++;return Response.json({code,latest_digest:latest,latest_version:2},{status:409});}return new Response(theirs);};
  const ui=setup(source);ui.body.querySelector('.amd-mode-raw').click();const input=ui.body.querySelector('.amd-raw');input.value='# My draft\n[link](https://example.com)\n';input.dispatchEvent(new Event('input'));ui.footer.querySelector('.amd-save').click();await observeUntil(ui.body,()=>!!ui.body.querySelector('.amd-open-latest'));assert.equal(input.value,'# My draft\n[link](https://example.com)\n');ui.body.querySelector('.amd-open-latest').click();await observeUntil(ui.body,()=>!ui.body.querySelector('.amd-kept').hidden);
  assert.equal(posts,1);assert.equal(ui.body.querySelector('.amd-kept-source').value,'\ufeff# My draft\n[link](https://example.com)\n');assert.equal(ui.body.querySelector('.amd-raw').value,'# Agent\n');assert.equal(ui.footer.querySelector('.amd-save').disabled,true);ui.close();
 }
});

test('raw oversize refusal keeps the entire draft and does not call fetch',async()=>{
 const ui=setup('Old.\n');let posts=0;globalThis.fetch=window.fetch=async()=>{posts++;throw Error('must not call');};ui.body.querySelector('.amd-mode-raw').click();const input=ui.body.querySelector('.amd-raw'),value='x'.repeat(2*1024*1024+1);input.value=value;input.dispatchEvent(new Event('input'));ui.footer.querySelector('.amd-save').click();await observeUntil(ui.body,()=>ui.body.querySelector('.amd-status').textContent.includes('2 MiB'));assert.equal(posts,0);assert.equal(input.value,value);assert.equal(ui.editor.dirty,true);ui.close();
});

test('raw Hub save accepts exactly 64 KiB with expected-latest and retains 64 KiB plus one without fallback',async()=>{
 const {state}=await importUi('state');state.hub=true;
 try {
  let calls=[];globalThis.fetch=window.fetch=async(url,options)=>{calls.push({url,...options});return Response.json({id:next,version:2});};
  let done;const saved=new Promise(r=>{done=r;});let ui=setup('Old.',done,api.editContext('m1','dev',hex));ui.body.querySelector('.amd-mode-raw').click();let input=ui.body.querySelector('.amd-raw');input.value='x'.repeat(64*1024);input.dispatchEvent(new Event('input'));ui.footer.querySelector('.amd-save').click();await saved;assert.equal(calls.length,1);assert.equal(calls[0].body.byteLength,64*1024);assert.ok(String(calls[0].url).includes('expected_latest='+hex));assert.ok(String(calls[0].url).includes('/remote/m1/'));ui.close();
  calls=[];ui=setup('Old.',()=>{},api.editContext('m1','dev',hex));ui.body.querySelector('.amd-mode-raw').click();input=ui.body.querySelector('.amd-raw');const value='x'.repeat(64*1024+1);input.value=value;input.dispatchEvent(new Event('input'));ui.footer.querySelector('.amd-save').click();await observeUntil(ui.body,()=>ui.body.querySelector('.amd-status').textContent.includes('64 KiB'));assert.equal(calls.length,0);assert.equal(input.value,value);assert.equal(ui.editor.dirty,true);ui.close();
 }finally{state.hub=false;}
});

test('mode switches never serialize DOM or normalize untouched source bytes',async()=>{
 const source='\ufeff# Title\r\n\r\nOld words.\nTail.\r\n';let sent;globalThis.fetch=window.fetch=async(url,options)=>{sent=options.body;return Response.json({id:next,version:2});};let done;const saved=new Promise(r=>{done=r;});const ui=setup(source,done);
 change(ui.body,'Old words.\nTail.','New words.\nTail.');for(let i=0;i<2;i++){ui.body.querySelector('.amd-mode-raw').click();ui.body.querySelector('.amd-mode-rendered').click();}ui.body.querySelector('.amd-mode-raw').click();ui.footer.querySelector('.amd-save').click();await saved;assert.equal(Buffer.from(sent).toString(),source.replace('Old','New'));ui.close();
 const noOp=setup(source);noOp.body.querySelector('.amd-mode-raw').click();const input=noOp.body.querySelector('.amd-raw');input.dispatchEvent(new Event('input'));noOp.body.querySelector('.amd-mode-rendered').click();assert.equal(noOp.editor.dirty,false);assert.equal(noOp.footer.querySelector('.amd-save').disabled,true);noOp.close();
});
