import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
installDom({mode:'local'});
const proto=window.HTMLDialogElement.prototype;
proto.showModal=function(){this.open=true;};proto.close=function(){this.open=false;this.dispatchEvent(new Event('close'));};
const oldCrypto=globalThis.crypto;
const calls=[];let refuse=true;
const {registerBundled}=await importUi('import_once');
registerBundled({'chief_checks_api.js':{
 loadChecks:async()=>({checks:[1,2].map(id=>({id,name:'Check '+id,enabled:true,instruction:'Check the result',schedule_kind:'interval',every_minutes:15}))}),
 loadAgents:async()=>[],loadChief:async()=>({}),loadTriggers:async()=>({triggers:[]}),
 runCheck:async(id,key)=>{calls.push({id,key});if(refuse){refuse=false;throw Error('Try again');}return{id};},
}});
Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)}});
let dialog;
try{
 const {showChiefChecks}=await importUi('chief_checks');await showChiefChecks();dialog=document.querySelector('dialog.chief-checks');
 const now=()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Run now');
 now().click();await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(calls.length,1,'Run now reaches API without crypto.randomUUID');
 assert.match(calls[0].key,/^[a-f0-9]{32}$/,'fallback makes a 128-bit random hex request key');
 const retryKey=calls[0].key;
 [...dialog.querySelectorAll('button')].find(b=>b.textContent==='Run all checks now').click();await new Promise(setImmediate);await new Promise(setImmediate);
 assert.deepEqual(calls.map(x=>x.id),[1,1,2],'Run all works on the same insecure-context crypto surface');
 assert.equal(calls[1].key,retryKey,'failed check keeps the same key on retry');
 assert.notEqual(calls[2].key,retryKey,'different checks get different random keys');
 globalThis.crypto.randomUUID=()=> '12345678-1234-4234-8234-123456789abc';
 now().click();await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(calls[3].key,'12345678-1234-4234-8234-123456789abc','secure-context randomUUID remains supported');
 console.log('chief_checks_lan: real Run now/all controls, fallback keys and retry identity pass');
}finally{dialog?.close();Object.defineProperty(globalThis,'crypto',{configurable:true,value:oldCrypto});}
