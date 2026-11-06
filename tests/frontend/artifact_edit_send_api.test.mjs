import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
installDom({mode:'local'});const API=await importUi('artifact_edit_send_api'),{editContext}=await importUi('artifact_markdown_api'),{invalidateArtifacts,onArtifactsRev}=await importUi('artifacts_feed');
const hex='a'.repeat(64),base='b'.repeat(64),context=editContext('m1','dev',hex);let calls=[],response;
globalThis.fetch=window.fetch=async(url,options={})=>{calls.push({url:String(url),...options});return response;};
test('permission is server-literal, scoped to the file computer/team, and has no diff text',async()=>{
 response=Response.json({can_send_edit:true,base_digest:base,base_version:1,version:2});calls=[];assert.ok(await API.editSendCapability(context));assert.equal(calls[0].url,`/api/remote/m1/api/board/dev/artifacts/${hex}/edit/send`);assert.equal(calls[0].method,undefined);
 response=Response.json({can_send_edit:'true',base_digest:base,base_version:1,version:2});assert.equal(await API.editSendCapability(context),null);
 for(const status of [403,404,405]){response=new Response('',{status});assert.equal(await API.editSendCapability(context),null);}
 response=Response.json({can_send_edit:true,base_digest:base,base_version:2,version:1});assert.equal(await API.editSendCapability(context),null);
});
test('explicit send carries recipient names only, preserves partial results, and never retries',async()=>{
 calls=[];response=Response.json({ok:false,thread_id:7,results:[{agent:'Writer',state:'paused',reason:'Paused'}],error:'The team is paused'},{status:409});const result=await API.sendSavedEdit(context,['Writer']);assert.equal(result.ok,false);assert.equal(result.commentId,7);assert.equal(result.results[0].state,'paused');assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].body),{agents:['Writer']});assert.equal(calls[0].method,'POST');assert.equal(calls[0].url,`/api/remote/m1/api/board/dev/artifacts/${hex}/edit/send`);
 await assert.rejects(API.sendSavedEdit(context,[]),/Choose/);await assert.rejects(API.sendSavedEdit(context,Array(11).fill('Writer')),/Choose/);assert.equal(calls.length,1);
});
test('HTTP 200 server result needs no extra success flag and exposes its existing thread',async()=>{
 response=Response.json({thread_id:19,limited:true,results:[{agent:'Writer',state:'already_sent'}]});const result=await API.sendSavedEdit(context,['Writer']);assert.equal(result.ok,true);assert.equal(result.commentId,19);assert.equal(result.omitted,true);assert.equal(result.results[0].state,'already_sent');
});
test('explicit save invalidation keeps the qualified team and clears freshness without faking a revision',()=>{
 const events=[];const off=onArtifactsRev((...args)=>events.push(args));invalidateArtifacts('@m1/dev');off();assert.deepEqual(events,[['@m1/dev',null,true,true]]);
});

test('a saved version invalidation carries both immutable digests on its qualified team',()=>{
 const events=[];const off=onArtifactsRev((...args)=>events.push(args));invalidateArtifacts('@m1/dev',{previous:base,digest:hex});off();assert.deepEqual(events,[['@m1/dev',null,true,{previous:base,digest:hex}]]);
});
