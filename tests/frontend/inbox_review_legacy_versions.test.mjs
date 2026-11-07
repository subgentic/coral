import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'}), hex=n=>n.toString(16).padStart(64,'0');
const artifact=(n,over={})=>({id:hex(n),board_id:'dev',name:'Plan.md',produced_by:'Writer',session_id:'writer-session',available:true,tags:['for review'],created_at:new Date(Date.parse('2026-11-06T10:00:00Z')+n*60000).toISOString(),...over});
const row={...artifact(60),team:'@box/dev',hex:hex(60),reviewKey:'@box/dev:'+hex(60)};
let mode='pages',calls=[];
globalThis.fetch=window.fetch=async input=>{
 const u=new URL(String(input),location.href);calls.push(u);
 if(mode==='refused')return Response.json({error:'owner_only'},{status:403});
 const second=u.searchParams.has('cursor');
 return Response.json({artifacts:second?[artifact(51),artifact(52),artifact(70),artifact(53,{produced_by:'Other'}),artifact(54,{board_id:'elsewhere'})]:Array.from({length:50},(_,i)=>artifact(i+1)),has_more:!second||mode==='repeat',next_cursor:'page2'});
};
const reviews=await importUi('inbox_reviews');
test('legacy expansion stays on source, board, uploader/name and reviewed version boundary',async()=>{
 const older=await reviews.legacyEarlierVersions(row);
 assert.deepEqual(older.map(a=>a.hex),Array.from({length:52},(_,i)=>hex(i+1)));
 assert.equal(calls.length,2);
 for(const u of calls){assert.equal(u.pathname,'/api/remote/box/api/team-artifacts');assert.equal(u.searchParams.get('team'),'dev');assert.equal(u.searchParams.get('by'),'Writer');assert.equal(u.searchParams.get('q'),'Plan.md');assert.equal(u.searchParams.get('versions'),'all');assert.equal(u.searchParams.get('limit'),'50');}
});
test('legacy expansion refuses owner-only and repeated cursor answers instead of partial settlement',async()=>{
 mode='refused';await assert.rejects(reviews.legacyEarlierVersions(row),/owner/);
 mode='repeat';await assert.rejects(reviews.legacyEarlierVersions(row),/completely/);
});
test.after(()=>dom.window.close());
