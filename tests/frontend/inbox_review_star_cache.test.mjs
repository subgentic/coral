import assert from 'node:assert/strict';
import test from 'node:test';
import {installDom,importUi} from './helpers/jsdom_env.mjs';
const dom=installDom({mode:'local'});
const hex=n=>n.toString(16).padStart(64,'0');
const artifacts=[1,2].map(n=>({board_id:'dev',id:hex(n),name:n===1?'Original.md':'Renamed.md',series_id:'same-series',produced_by:'Dev'+n,session_id:'session'+n,available:true,tags:['for review'],created_at:`2026-11-06T10:0${n}:00Z`}));
globalThis.fetch=window.fetch=async url=>{const u=new URL(String(url),location.href);if(u.pathname==='/api/board/projects')return Response.json([{project:'dev'}]);if(u.pathname==='/api/team-artifacts'&&!u.searchParams.has('starred_first'))return Response.json({artifacts:[],has_more:false});return Response.json({artifacts:u.searchParams.get('tag')==='saved'?[]:artifacts,has_more:false});};
const reviews=await importUi('inbox_reviews');
test('acknowledged star survives rebuilding a collapsed series row',async()=>{
 await reviews.refreshReviews(true);
 const rows=reviews.reviewItems();assert.equal(rows.length,1);assert.equal(rows[0].hex,hex(2));assert.equal(rows[0].earlier.length,1);
 reviews.reviewStarChanged(rows[0],true);
 assert.equal(reviews.reviewItems()[0].starred,true);
 reviews.reviewStarChanged(reviews.reviewItems()[0],false);
 assert.equal(reviews.reviewItems()[0].starred,false);
});
test.after(()=>dom.window.close());
