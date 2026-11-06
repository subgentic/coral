import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { installDom, importUi, STATIC } from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});dom.window.eval(fs.readFileSync(STATIC+'vendor/marked.min.js','utf8'));globalThis.marked=dom.window.marked;dom.window.eval(fs.readFileSync(STATIC+'vendor/purify.min.js','utf8'));globalThis.DOMPurify=dom.window.DOMPurify;
const hex='a'.repeat(64),base='b'.repeat(64);let calls=[];
globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url:String(url),...options});const p=new URL(String(url),location.href).pathname;if(p.endsWith('/edit/send'))return Response.json({can_send_edit:true,base_digest:base,base_version:1,version:2,sent_to:[]});if(p.endsWith('/edit'))return Response.json({can_edit:true});if(/\/api\/artifacts\/[a-f0-9]{64}$/.test(p))return new Response('# Report\n\nSaved words.\n',{headers:{'Content-Type':'text/markdown','Content-Disposition':'attachment; filename="report.md"'}});return new Response('',{status:404});};
const viewer=await importUi('artifact_viewer');
const until=predicate=>predicate()?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(Error('condition not reached'));},2000);const observer=new MutationObserver(()=>{if(predicate()){clearTimeout(timer);observer.disconnect();resolve();}});observer.observe(document.body,{subtree:true,childList:true,attributes:true});});
test('an Operator-saved version offers a separate Send action; opening it never sends automatically',async()=>{
 try{viewer.openArtifactViewer(hex,{board:'dev',server:'local',filename:'report.md',editSaved:true});
 assert.ok(document.querySelector('.artifact-edit-send-action'),'saved file has an explicit Send action');
 await until(()=>!document.querySelector('.artifact-edit-send-action').hidden);
 assert.match(document.querySelector('.artifact-edit-send-note').textContent,/separate|not.*automatically/i);
 assert.equal(calls.filter(c=>c.method==='POST'&&(/edit\/send|comments/.test(c.url))).length,0);
 }finally{document.querySelector('.artifact-viewer-close')?.click();}
});
