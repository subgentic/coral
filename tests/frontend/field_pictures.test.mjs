import assert from 'node:assert/strict';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});
try {
 URL.createObjectURL=()=> 'blob:picture';URL.revokeObjectURL=()=>{};
 const {createFieldPictures,picturePayload,savedWords}=await importUi('field_pictures');
 const requests=[];let fail=false,finish;
 globalThis.fetch=async(url,options)=>{requests.push({url:String(url),options});if(fail)return new Response(JSON.stringify({error:'offline'}),{status:503});if(finish)return new Promise(resolve=>finish.resolve=resolve);return new Response(JSON.stringify({hex:'b'.repeat(64)}),{status:201})};
 const until=(p,pred)=>new Promise(resolve=>{if(pred())return resolve();p.listen(()=>{if(pred())resolve()})});
 const quiet=createFieldPictures({project:'alpha',field:'content'});assert.equal(quiet.node.querySelectorAll('[role=status]').length,0,'an empty tray adds no unused live region to the reply form');quiet.add([new File(['text'],'Not a picture.txt',{type:'text/plain'})]);assert.match(quiet.node.querySelector('[role=status]').textContent,/Only PNG/);quiet.clear();assert.equal(quiet.node.querySelectorAll('[role=status]').length,0,'clearing the notice removes its status role');quiet.destroy();
 const conditional=createFieldPictures({project:'alpha',field:'description',hintWhenAdded:true,includeDraft:false,uploadPicture:async()=>({hex:'d'.repeat(64)})});
 assert.equal(conditional.node.querySelector('.ac-images-hint').hidden,true,'part 2 hides the empty privacy hint');
 conditional.add([new File(['png'],'New.png',{type:'image/png'})]);await until(conditional,()=>!conditional.busy());
 assert.equal(conditional.node.querySelector('.ac-images-hint').hidden,false,'the full privacy hint is shown before saving a picture');
 assert.deepEqual(conditional.payload(),{images:{description:['d'.repeat(64)]}},'legacy editors use their upload route without a draft field');
 conditional.acceptSaved();assert.deepEqual(conditional.payload(),{},'settings rebase only after pictures save');
 conditional.remove(conditional.items()[0].id);assert.equal(conditional.node.querySelector('.ac-images-hint').hidden,true);assert.deepEqual(conditional.payload(),{images:{description:[]}});conditional.destroy();
 const initial=createFieldPictures({project:'alpha',field:'description',initial:[{hex:'a'.repeat(64),name:'Existing.png'}]});
 assert.equal(initial.node.querySelector('.ac-images-hint').hidden,false,'ordinary fields retain the unconditional hint');
 assert.deepEqual(initial.payload(),{},'untouched pictures are omitted');initial.remove(initial.items()[0].id);assert.deepEqual(initial.payload().images,{description:[]},'removing the last existing picture explicitly clears');
 const p=createFieldPictures({project:'alpha',scope:'task',field:'description',draft:'same-draft'}),q=createFieldPictures({project:'alpha',scope:'task',field:'instructions',draft:'same-draft'});
 fail=true;p.add([new File(['png'],'Failure.png',{type:'image/png'})]);await until(p,()=>p.failed());assert.throws(()=>p.payload(),/Retry or remove/);assert.equal(p.items().length,1);
 fail=false;p.node.querySelector('.picture-retry').click();await until(p,()=>!p.busy());q.add([new File(['png'],'Workflow.png',{type:'image/png'})]);await until(q,()=>!q.busy());
 assert.deepEqual(picturePayload(p,q),{images:{description:['b'.repeat(64)],instructions:['b'.repeat(64)]},images_draft:'same-draft'});
 assert.ok(requests.every(r=>r.url.includes('/api/board/alpha/field-images?scope=task&draft=same-draft')));
 const remote=createFieldPictures({project:'@remote-box/other',field:'content',scope:'chat'});remote.add([new File(['png'],'Remote.png',{type:'image/png'})]);await until(remote,()=>!remote.busy());assert.match(requests.at(-1).url,/\/api\/remote\/remote-box\/api\/board\/other\/field-images\?scope=chat/);
 // Destroying a mounted field removes its listeners. A late upload result cannot restore a removed item.
 const form=document.createElement('form'),ta=document.createElement('textarea');form.append(ta,p.node);document.body.append(form);p.attach(form,ta);p.destroy();const before=requests.length;
 const paste=new dom.window.Event('paste');Object.defineProperty(paste,'clipboardData',{value:{files:[new File(['png'],'Late.png',{type:'image/png'})],getData:()=>''}});ta.dispatchEvent(paste);await Promise.resolve();assert.equal(requests.length,before);
 finish={};const late=createFieldPictures({project:'alpha',field:'content'});late.add([new File(['png'],'Pending.png',{type:'image/png'})]);await Promise.resolve();await Promise.resolve();assert.equal(typeof finish.resolve,'function');late.destroy();finish.resolve(new Response(JSON.stringify({hex:'c'.repeat(64)}),{status:201}));await Promise.resolve();await Promise.resolve();assert.equal(late.items().length,0,'a late result cannot restore a destroyed draft');
 assert.match(savedWords({pictures_not_saved:true},'Saved'),/Pictures not saved/);assert.equal(savedWords({},'Saved'),'Saved');
 initial.destroy();q.destroy();remote.destroy();console.log('field pictures: scoped drafts, retry, unchanged omission, explicit clear, detached listeners, and partial-save warning');
} finally {dom.window.close()}
