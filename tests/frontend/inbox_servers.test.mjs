import assert from 'node:assert/strict';
import { state } from '../../coral-go/pkg/frontend/static/state.js';
import { serverColumns, serverMatches, serverOf, readInboxArtifacts, multipleServers } from '../../coral-go/pkg/frontend/static/inbox_servers.js';
state.hub = true; state.servers = [{id:'local'}, {id:'box-2',label:'Remote box',status:'online'}];
assert.equal(serverOf({board_id:'@box-2/same'}),'box-2');
assert.equal(serverOf({project:'same'}),'local');
assert.equal(serverMatches({server:'local'},{server:'box-2'}),false);
assert.equal(serverColumns()[0].cell({server:'local'}),'This computer');
assert.equal(serverColumns()[0].sortValue({server:'box-2'}),'Remote box');
const reads=[];
globalThis.fetch = async url => {
 const u=new URL(url,'http://localhost'), remote=u.pathname.includes('/remote/box-2/');reads.push(u);
 if(remote){assert.notEqual(u.searchParams.get('cursor'),'local-cursor');return Response.json({artifacts:[{id:'same',board_id:'same'}],teams:[{board_id:'same'}],total:1,all:1,has_more:false});}
 const last=u.searchParams.get('cursor')==='local-cursor';
 return Response.json({artifacts:[{id:last?'next':'same',board_id:'same'}],teams:[{board_id:'same'}],total:2,all:2,has_more:!last,next_cursor:last?'':'local-cursor'});
};
const first=await readInboxArtifacts(new URLSearchParams({limit:'1'}));
assert.deepEqual(first.artifacts.map(r=>r.board_id),['same','@box-2/same']);
assert.equal(first.total,3);
const second=await readInboxArtifacts(new URLSearchParams({limit:'1',cursor:first.next_cursor}));
assert.equal(second.artifacts.length,1,'completed remote source is not loaded twice');
assert.equal(second.has_more,false);
assert.equal(reads.length,3);
reads.length=0;
const selected=await readInboxArtifacts(new URLSearchParams({limit:'1',team:'@box-2/same'}),{server:'box-2',team:'@box-2/same'});
assert.equal(selected.artifacts[0].server,'box-2');assert.equal(reads.length,1);assert.equal(reads[0].searchParams.get('team'),'same');
for (const cursor of ['old-cursor', 'null', '[]', '42', '"old-cursor"', '{"local":"old-cursor"}']) {
 reads.length=0;
 const restarted=await readInboxArtifacts(new URLSearchParams({cursor}));
 assert.equal(restarted.artifacts.length,2,'invalid cursor restarts all sources');
 assert.ok(reads.every(u=>!u.searchParams.has('cursor')&&u.searchParams.get('offset')==='0'),'invalid cursor never reaches a source');
}
assert.equal(Object.getPrototypeOf(first.tag_counts),null,'remote tag names do not inherit object keys');
state.hub=false;
assert.equal(multipleServers(),false);assert.deepEqual(serverColumns(),[]);assert.equal(serverMatches({server:'local'},{server:'box-2'}),true);
state.hub=true;state.servers=[{id:'local'}];assert.equal(multipleServers(),false);
console.log('inbox_servers: PASS sources, identity, selection and independent pagination');

state.hub=true;state.servers=[{id:'local'},{id:'box-2',status:'online'}];
const history=await import('../../coral-go/pkg/frontend/static/history_source.js');
assert.equal(history.setHistorySource('box-2'),true);assert.equal(history.historyRoute('same').server,'box-2');
await assert.rejects(()=>history.historyFetch('/api/sessions/history/same/flags',{method:'PATCH'}),/read-only/);
assert.equal(history.setHistorySource('local'),true);assert.equal(history.historyServer(),'local');
assert.equal(history.setHistorySource('missing'),false);
