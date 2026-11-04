import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTypingTrace} from './typing_trace.mjs';
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
