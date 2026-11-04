import assert from 'node:assert/strict';
import cp from './helpers/child_process.js';
const { spawnSync } = cp;
import { fileURLToPath } from 'node:url';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const local=process.argv.includes('--local');
const dom=installDom({mode:local?'local':'cloud'});
const {state}=await importUi('state');state.hub=true;state.servers=[{id:'srv1',status:'online'}];
const M=await importUi('inbox_reviews');
const ui=await importUi('artifact_review');
const ids=['a'.repeat(64),'b'.repeat(64)];
const rows=ids.map((id,i)=>({id,name:'Film',session_id:'writer',produced_by:'Writer',uri:'coral://artifacts/'+id,tags:['for review'],available:true,created_at:`2026-11-03T10:0${i}:00Z`}));
let mode='ok',calls=[];
globalThis.fetch=async(url,opts={})=>{
 const u=new URL(String(url),'https://hub.example/');
 if(u.pathname.endsWith('/api/board/projects'))return Response.json([{project:'team'}]);
 if(u.pathname.endsWith('/artifacts'))return Response.json({artifacts:rows,has_more:false});
 if(u.pathname.endsWith('/tags') && opts.method==='PUT')return Response.json({error:'local write failed'},{status:404});
 if(u.pathname.endsWith('/review')){
  const body=JSON.parse(opts.body);calls.push({path:u.pathname,body});
  if(u.pathname.includes(ids[0]) && mode!=='ok')return Response.json({code:mode,error:'already settled'}, {status:mode==='missing_route'?404:409});
  return Response.json({ok:true,delivered:false,review:{at:'2026-11-03T11:00:00Z'}});
 }
 return Response.json({}, {status:404});
};
await M.refreshReviews(true);
let row=M.reviewItems()[0];assert.equal(M.earlierVersions(row).length,1,'fixture has a real earlier version');
if(local) {
 const out=await ui.approveRow(row.team,row);
 assert.deepEqual(out.earlier,{settled:0,failed:1},'a real 404 on this computer still counts as failed');
} else {
let out=await ui.approveRow(row.team,row);
assert.deepEqual(out.earlier,{settled:1,failed:0});
assert.deepEqual(calls.find(c=>c.path.includes(ids[0])).body,{decision:'ignore',quiet:true},'automatic settlement is distinguished from an Operator dismissal');
for(const [code,expected] of [['not_for_review',{settled:1,failed:0}],['some_other_conflict',{settled:0,failed:1}],['missing_route',{settled:0,failed:0}]]){
 mode=code;calls=[];await M.refreshReviews(true);row=M.reviewItems()[0];out=await ui.approveRow(row.team,row);
 assert.deepEqual(out.earlier,expected,code);
}
// The same conflict on the person's own decision must still surface as a failure.
await assert.rejects(()=>ui.ignoreRow(row.team,{...row,id:ids[0]}),/already settled/);
 const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--local'],{encoding:'utf8'});assert.equal(child.status,0,child.stdout+child.stderr);
}
dom.window.close();
console.log('hub_review_settlement: quiet automatic settlement and precise already-settled conflict pass');
