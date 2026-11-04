import assert from 'node:assert/strict';
import {mergeArtifactWindow} from '../../coral-go/pkg/frontend/static/artifact_loaded_window.js';
const key=r=>`${r.server}:${r.id}`,source=r=>r.server;
const rows=(n,server='local')=>Array.from({length:n},(_,i)=>Object.freeze({server,id:i+1}));
const old=rows(300),fresh=old.slice(0,100),adds=[{server:'local',id:1003},{server:'local',id:1002},{server:'local',id:1001}];
const previous={items:old,cursor:'opaque-after-300',hasMore:true,truncated:false};
let out=mergeArtifactWindow(previous,{artifacts:fresh,next_cursor:'opaque-after-100',has_more:true,total:700},key);
assert.deepEqual(out.items,old);assert.equal(out.cursor,'opaque-after-300');assert.equal(out.hasMore,true);
out=mergeArtifactWindow(previous,{artifacts:[...adds,...old.slice(0,97)],next_cursor:'opaque-after-97',has_more:true,total:703},key);
assert.equal(out.items.length,303);assert.deepEqual(out.items,[...adds,...old]);assert.equal(out.cursor,'opaque-after-300');
const without25=old.filter(r=>r.id!==25).slice(0,100);
out=mergeArtifactWindow(previous,{artifacts:without25,next_cursor:'new-prefix-cursor',has_more:true,total:699},key);
assert.equal(out.items.length,299);assert.equal(out.items.some(r=>r.id===25),false,'removed prefix row is not resurrected');assert.equal(out.items.at(-1).id,300);
out=mergeArtifactWindow(previous,{artifacts:[],next_cursor:'',has_more:false,total:0},key);
assert.deepEqual(out.items,[],'authoritative empty result removes old rows');assert.equal(out.hasMore,false);
const remote=rows(3,'remote-a');
const priorMeta={local:{cursor:'local-tail',offset:300,done:false,total:700},'remote-a':{cursor:'remote-tail',offset:3,done:false,total:20}};
const nextMeta={local:{cursor:'local-prefix',offset:100,done:false,total:703},'remote-a':{cursor:'',offset:0,done:true,failed:true,total:0}};
const multi={items:[...old,...remote],cursor:JSON.stringify(priorMeta),hasMore:true,truncated:false};
const incoming={artifacts:[...adds,...old.slice(0,97)],next_cursor:JSON.stringify(nextMeta),has_more:true};
out=mergeArtifactWindow(multi,incoming,key,source);
assert.deepEqual(out.items,[...adds,...old,...remote],'failed source keeps its own cached rows');
let cursors=JSON.parse(out.cursor);
assert.equal(cursors.local.cursor,'local-tail');assert.equal(cursors.local.offset,303);
assert.equal(cursors['remote-a'].cursor,'remote-tail');assert.equal(cursors['remote-a'].offset,3);
assert.equal(cursors['remote-a'].failed,true);
nextMeta['remote-a']={done:true,ownerOnly:true};
out=mergeArtifactWindow(multi,{...incoming,next_cursor:JSON.stringify(nextMeta)},key,source);
assert.equal(out.items.some(r=>r.server==='remote-a'),false,'owner-only denial removes cached source rows');
delete nextMeta['remote-a'];
out=mergeArtifactWindow(multi,{...incoming,next_cursor:JSON.stringify(nextMeta)},key,source);
assert.equal(out.items.some(r=>r.server==='remote-a'),false,'removed source is not resurrected');
priorMeta.local.cursor='';
out=mergeArtifactWindow({...multi,cursor:JSON.stringify(priorMeta)},{...incoming,next_cursor:JSON.stringify(nextMeta)},key,source);
cursors=JSON.parse(out.cursor);assert.equal(cursors.local.cursor,'');assert.equal(cursors.local.offset,303,'legacy offset advances by inserted rows without rewinding to page 1');
assert.equal(previous.items.length,300);assert.equal(previous.cursor,'opaque-after-300','input state is not mutated');
// #13459 (QA's SHOULDs on #13160): three rules of the merge that nothing pinned.
// 1. ownerOnly passes through: a source the owner alone may read keeps its own cursor entry exactly as the server sent it (the marker stays, the prior cursor is not carried over), its cached rows are dropped, and it never keeps the list open.
{
    const prior={local:{cursor:'local-tail',offset:300,done:false,total:700},'remote-a':{cursor:'remote-tail',offset:3,done:false,total:20}};
    const denied={done:true,ownerOnly:true};
    const next={local:{cursor:'local-prefix',offset:100,done:true,total:303},'remote-a':denied};
    const win={items:[...old,...remote],cursor:JSON.stringify(prior),hasMore:true,truncated:false};
    const o=mergeArtifactWindow(win,{artifacts:[...adds,...old.slice(0,97)],next_cursor:JSON.stringify(next),has_more:false},key,source);
    const c=JSON.parse(o.cursor);
    assert.deepEqual(c['remote-a'],denied,'ownerOnly entry is passed through unchanged (no prior cursor or offset carried over)');
    assert.equal(o.items.some(r=>r.server==='remote-a'),false,'ownerOnly drops the cached rows of that source');
    assert.equal(o.hasMore,false,'an ownerOnly source (done) does not keep the list open; the other source is done too');
}
// 2. 'done' is the prior done AND the total is covered: a source whose tail is still cached stays done only if its total is not above the rows now held (or no total is known); a prior that was not done never becomes done here.
{
    const merge=(priorDone,total)=>{
        const prior={local:{cursor:'local-tail',offset:300,done:priorDone,total:300}};
        const nx={local:{cursor:'local-prefix',offset:100,done:false,...(total===undefined?{}:{total})}};
        const o=mergeArtifactWindow({items:old,cursor:JSON.stringify(prior),hasMore:!priorDone,truncated:false},{artifacts:fresh,next_cursor:JSON.stringify(nx),has_more:true},key,source);
        return {items:o.items,c:JSON.parse(o.cursor).local,hasMore:o.hasMore};
    };
    let r=merge(true,300);   // 300 rows held, total 300: covered
    assert.equal(r.items.length,300);assert.equal(r.c.done,true,'prior done and total equals the rows held: done');assert.equal(r.hasMore,false);
    r=merge(true,299);       // total below the rows held (rows were removed elsewhere): covered
    assert.equal(r.c.done,true,'prior done and total below the rows held: done');
    r=merge(true,301);       // one row more exists than is held: not done
    assert.equal(r.c.done,false,'prior done but the total is above the rows held: not done');assert.equal(r.hasMore,true,'the list stays open for the row that is not held');
    r=merge(true,undefined); // no total known: the prior's word stands
    assert.equal(r.c.done,true,'prior done and no total: done');
    r=merge(false,300);      // a prior that was not done is not made done by a total
    assert.equal(r.c.done,false,'a prior that was not done stays not done even when the total is covered');
    r=merge(true,'999');     // a total that is not an integer is no total ('999' would read as above the rows held if it were compared)
    assert.equal(r.c.done,true,'a non-integer total is ignored');
}
// 3. truncated carries over: either side's truncation marks the merged window, and neither side clears the other's.
{
    const m=(a,b)=>mergeArtifactWindow({items:old,cursor:'c',hasMore:true,truncated:a},{artifacts:fresh,next_cursor:'n',has_more:true,total:700,...(b===undefined?{}:{truncated:b})},key).truncated;
    assert.equal(m(true,false),true,'a truncated window stays truncated after a read that is not');
    assert.equal(m(true,undefined),true,'a truncated window stays truncated when the read says nothing');
    assert.equal(m(false,true),true,'a truncated read marks the window');
    assert.equal(m(false,false),false,'neither side truncated: not truncated');
    assert.equal(m(false,undefined),false,'nothing says truncated: not truncated');
}
console.log('artifact_loaded_window: prefix merge, tail cursor, prepend/delete, per-source errors/denials, ownerOnly pass-through, done against the total, truncated carry-over and legacy offset pass');
