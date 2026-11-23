// A failed upload must stay removable/retryable without sending a partial picture set.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({mode:'local'});
try {
 let n=0; const revoked=[]; URL.createObjectURL=()=>`blob:tray-${++n}`; URL.revokeObjectURL=u=>revoked.push(u);
 const {createImageTray}=await importUi('artifact_comment_images');
 let calls=0, finish, started; const uploadStarted=new Promise(r=>started=r);
 const tray=createImageTray({upload:async()=>{calls++;if(calls===1)throw Error('Computer offline');return new Promise(r=>{finish=r;started()})}});
 const form=document.createElement('form'),text=document.createElement('textarea');text.value='Keep my draft';form.append(text,tray.node,tray.picker());document.body.append(form);tray.attach(form,text);
 const until=pred=>new Promise(resolve=>{if(pred())return resolve();tray.listen(()=>{if(pred())resolve()})});
 tray.add([new File(['png'],'reference.png',{type:'image/png'})]);await until(()=>tray.failed());
 assert.match(tray.node.textContent,/Computer offline/);assert.equal(tray.hexes().length,0);assert.equal(tray.busy(),false);
 const retry=tray.node.querySelector('.picture-retry');assert.ok(retry,'failed item keeps Retry beside named removal');retry.click();assert.equal(tray.busy(),true);assert.equal(tray.failed(),false);
 await uploadStarted;
 finish({hex:'a'.repeat(64)});await until(()=>!tray.busy());assert.deepEqual(tray.hexes(),['a'.repeat(64)]);assert.equal(text.value,'Keep my draft');assert.equal(calls,2);
 tray.node.querySelector('.ac-thumb-remove').click();assert.equal(tray.items().length,0);assert.deepEqual(revoked,['blob:tray-1']);tray.destroy();
 console.log('picture_tray: failed picture retained, retry replaces same draft, words kept, named removal releases preview');
} finally {dom.window.close()}
