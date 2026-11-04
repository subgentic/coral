import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTypingTrace,typingTraceCoverage} from './typing_trace.mjs';
const main={name:'thread_name',ph:'M',pid:1,tid:7,ts:0,args:{name:'CrRendererMain'}};
test('uses process + thread, strict 50 ms threshold, and preserves nested attribution',()=>{
 const rows=summarizeTypingTrace([main,
 {name:'RunTask',ph:'X',pid:1,tid:7,ts:100,dur:50000},
 {name:'RunTask',ph:'X',pid:2,tid:7,ts:100,dur:100000},
 {name:'ThreadControllerImpl::RunTask',ph:'X',pid:1,tid:7,ts:60000,dur:80000},
 {name:'Layout',ph:'X',pid:1,tid:7,ts:70000,dur:60000}],null);
 assert.equal(rows.length,1);assert.equal(rows[0].ms,80);assert.equal(rows[0].events[0].event,'Layout');
});
test('reconstructs begin/end tasks and clips CPU samples to each task',()=>{
 const rows=summarizeTypingTrace([main,
 {name:'RunTask',ph:'B',pid:1,tid:7,ts:10000},
 {name:'FunctionCall',ph:'B',pid:1,tid:7,ts:20000},
 {ph:'E',pid:1,tid:7,ts:75000},
 {ph:'E',pid:1,tid:7,ts:90000}],{startTime:0,nodes:[{id:1,callFrame:{functionName:'drawSidebar',url:'render.js',lineNumber:4,columnNumber:2}}],samples:[1,1,1],timeDeltas:[20000,40000,40000]});
 assert.equal(rows.length,1);assert.equal(rows[0].events[0].ms,55);
 assert.deepEqual(rows[0].owners,[{function:'drawSidebar',url:'render.js',line:5,column:3,selfMs:80}]);
});

test('typing marker restricts attribution to its renderer and nested RunTask is counted once',()=>{
 const rows=summarizeTypingTrace([main,{...main,pid:2},
 {name:'coral-typing-start',ph:'R',pid:1,tid:7,ts:1},
 {name:'RunTask',ph:'X',pid:1,tid:7,ts:100,dur:90000},
 {name:'RunTask',ph:'X',pid:1,tid:7,ts:1000,dur:60000},
 {name:'RunTask',ph:'X',pid:2,tid:7,ts:100,dur:120000}],null);
 assert.equal(rows.length,1);assert.equal(rows[0].pid,1);assert.equal(rows[0].ms,90);
});

test('outer measurement gate preserves child failures and diagnostic logs without a browser',async()=>{
 const {spawnSync}=await import('node:child_process');
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'typing-gate-'));
 const helper=new URL('./typing_measure_gate.sh',import.meta.url).pathname;
 try {
  for(const [gate,child,expected] of [['1',7,7],['1',0,0],['0',7,0],['',7,0]]) {
   const log=path.join(dir,'child log.txt');
   const out=spawnSync('bash',['-c',`source "$1"; run_bigboard_measure fixture "$2" bash -c 'printf diagnostic; exit "$1"' -- "$3"`,'--',helper,log,String(child)],{env:{...process.env,TYPING_GATE:gate},encoding:'utf8'});
   assert.equal(out.status,expected,out.stderr);assert.equal(fs.readFileSync(log,'utf8'),'diagnostic');
   assert.match(out.stdout,new RegExp('fixture measure exit='+child));
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

const boundary = (name,ts) => ({name,ts,ph:'R',pid:1,tid:7});
test('the budget keeps exact durations at 50 ms and flags QA’s 51 ms task',()=>{
 const rows=summarizeTypingTrace([main,
  {name:'RunTask',ph:'X',pid:1,tid:7,ts:0,dur:50000},
  {name:'RunTask',ph:'X',pid:1,tid:7,ts:60000,dur:50001},
  {name:'RunTask',ph:'X',pid:1,tid:7,ts:120000,dur:51000}],null);
 assert.deepEqual(rows.map(r=>r.durationUs),[51000,50001]);
 assert.equal(rows[0].ms,51);
});
test('completed renderer work and both boundary markers are required for a green budget',()=>{
 const trace=[main,boundary('coral-typing-start',10),{name:'RunTask',ph:'X',pid:1,tid:7,ts:20,dur:1000},boundary('coral-typing-end',2000)];
 assert.deepEqual(typingTraceCoverage(trace),{traceComplete:true,rendererTaskCount:1});
 assert.equal(typingTraceCoverage(trace.filter(e=>e.name!=='thread_name')).traceComplete,false);
 assert.equal(typingTraceCoverage(trace.filter(e=>e.name!=='coral-typing-end')).traceComplete,false);
 assert.equal(typingTraceCoverage(trace.filter(e=>e.name!=='RunTask')).traceComplete,false);
});
test('an unclosed RunTask overlapping the burst cannot hide behind another completed task',()=>{
 const trace=[main,boundary('coral-typing-start',100),
  {name:'RunTask',ph:'X',pid:1,tid:7,ts:200,dur:1000},
  {name:'RunTask',ph:'B',pid:1,tid:7,ts:2000},boundary('coral-typing-end',60000)];
 assert.equal(typingTraceCoverage(trace).traceComplete,false);
 assert.equal(typingTraceCoverage(trace.map(e=>e.ph==='B'?{...e,ts:61000}:e)).traceComplete,true,'work beginning after typing is outside the budget');
 const complete=[...trace,{ph:'E',pid:1,tid:7,ts:65000}];
 assert.equal(typingTraceCoverage(complete).traceComplete,true);
 assert.equal(summarizeTypingTrace(complete,null)[0].durationUs,63000);
});

test('a typing gate without tracing is rejected before a fixture or browser is needed',async()=>{
 const {spawnSync}=await import('node:child_process');
 const env={...process.env,PERF_RUN:'1',TYPING_GATE:'1',TYPING_TRACE:''};
 for (const [command,file] of [['bash','bigboard_run.sh'],[process.execPath,'bigboard_measure.mjs']]) {
  const result=spawnSync(command,[new URL('./'+file,import.meta.url).pathname],{env,encoding:'utf8'});
  assert.equal(result.status,2,result.stdout+result.stderr);
  assert.match(result.stderr,/TYPING_GATE requires TYPING_TRACE=1/);
 }
});
