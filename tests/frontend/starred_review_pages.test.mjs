import assert from 'node:assert/strict';import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'cloud'});const {state}=await importUi('state');state.hub=true;state.servers=[{id:'m1',status:'online'}];
let calls=[],fail=false,partial=false;const id=n=>String(n).repeat(64);
globalThis.fetch=window.fetch=async url=>{const u=new URL(String(url),location.href);calls.push(u.pathname+u.search);if(fail)return new Response('',{status:503});return Response.json({artifacts:[{id:u.searchParams.get('offset')==='0'?id(1):id(2),series_id:u.searchParams.get('offset')==='0'?'series-a':'series-b',name:'Pinned.md',starred:true,board_id:'dev'}],total:2,...(partial?{partial:true,failed_boards:['missing-team']}:{}),has_more:u.searchParams.get('offset')==='0'});};
const stars=await importUi('mailbox_starred_artifacts');
const read=()=>new Promise(resolve=>stars.ensureStarredArtifacts(resolve));
test('Hub Starred reads every source page and uses newest-series semantics',async()=>{
 await read();assert.equal(calls.length,2);assert.ok(calls.every(p=>p.startsWith('/api/remote/m1/api/team-artifacts?')&&p.includes('starred=true')&&p.includes('starred_first=true')&&!p.includes('versions=')));assert.equal(stars.starredArtifactCount(),2);assert.equal(stars.starredArtifactsSection().querySelectorAll('.dt-row').length,2);
});
test('a failed refresh retains rows, exposes Retry and does not automatically loop',async()=>{
 fail=true;document.dispatchEvent(new Event('artifact-star-changed'));await read();const count=calls.length;
 assert.equal(stars.starredArtifactCount(),null,'failed source totals are unknown');const section=stars.starredArtifactsSection();assert.ok(section.textContent.includes('could not be read'));assert.equal(section.querySelectorAll('.dt-row').length,2);assert.ok([...section.querySelectorAll('button')].some(b=>b.textContent==='Retry'));
 stars.ensureStarredArtifacts();assert.equal(calls.length,count);
});
test('partial team failures do not certify a complete Starred count',async()=>{fail=false;partial=true;document.dispatchEvent(new Event('artifact-star-changed'));await read();assert.equal(stars.starredArtifactCount(),null);assert.match(stars.starredArtifactsSection().textContent,/Some starred documents could not be read/);});
test.after(()=>dom.window.close());
