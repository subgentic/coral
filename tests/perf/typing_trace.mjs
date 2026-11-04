// #13156: optional typing trace for the #13154 real big-board rig. This module
// starts no server/browser and never wakes agents: the rig owns those lifetimes.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const ms = us => Math.round(us / 100) / 10;
const sourceOf = frame => ({ function: frame.functionName || '(anonymous)', url: frame.url || '', line: (frame.lineNumber ?? -1) + 1, column: (frame.columnNumber ?? -1) + 1 });

/** Attribute samples by overlapping time, not by nested inclusive event totals. */
export function summarizeTypingTrace(events, profile, thresholdMs = 50) {
    const marker = events.find(e => e.name === 'coral-typing-start');
    const main = new Set(events.filter(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map(e => `${e.pid}/${e.tid}`));
    if (marker) for (const key of main) if (key !== `${marker.pid}/${marker.tid}`) main.delete(key);
    const complete = [];
    const stacks = new Map();
    for (const e of [...events].sort((a,b) => a.ts-b.ts)) {
        const key = `${e.pid}/${e.tid}`;
        if (!main.has(key)) continue;
        if (e.ph === 'X' && Number.isFinite(e.dur)) complete.push(e);
        else if (e.ph === 'B') { const stack = stacks.get(key) || []; stack.push(e); stacks.set(key, stack); }
        else if (e.ph === 'E') { const begin = stacks.get(key)?.pop(); if (begin) complete.push({...begin, ph:'X', dur:e.ts-begin.ts}); }
    }
    const nodes = new Map((profile?.nodes || []).map(n => [n.id,n]));
    const samples = []; let at = profile?.startTime || 0;
    for (let i=0;i<(profile?.samples?.length || 0);i++) {
        const end = at+(profile.timeDeltas?.[i] || 0);
        samples.push({start:at,end,node:nodes.get(profile.samples[i])}); at=end;
    }
    const tasks=[];
    for (const task of complete.filter(e => /(?:^|::)RunTask$/.test(e.name) && e.dur>thresholdMs*1000).sort((a,b)=>a.ts-b.ts || b.dur-a.dur)) {
        if (!tasks.some(parent=>parent.pid===task.pid&&parent.tid===task.tid&&parent.ts<=task.ts&&parent.ts+parent.dur>=task.ts+task.dur)) tasks.push(task);
    }
    return tasks.sort((a,b)=>b.dur-a.dur).map(task => {
        const owned = new Map();
        for (const sample of samples) {
            const overlap = Math.max(0,Math.min(task.ts+task.dur,sample.end)-Math.max(task.ts,sample.start));
            if (!overlap || !sample.node) continue;
            const frame=sourceOf(sample.node.callFrame), key=JSON.stringify(frame);
            const row=owned.get(key)||{...frame,selfUs:0};row.selfUs+=overlap;owned.set(key,row);
        }
        const inside=complete.filter(e=>e!==task && e.pid===task.pid && e.tid===task.tid && e.ts>=task.ts && e.ts+e.dur<=task.ts+task.dur && e.dur>=1000)
            .sort((a,b)=>b.dur-a.dur).slice(0,20).map(e=>({event:e.name,ms:ms(e.dur),...(e.args?.data?.url?{url:e.args.data.url}:{}),...(e.args?.data?.functionName?{function:e.args.data.functionName}:{})}));
        return {startUs:task.ts,endUs:task.ts+task.dur,ms:ms(task.dur),pid:task.pid,tid:task.tid,owners:[...owned.values()].sort((a,b)=>b.selfUs-a.selfUs).slice(0,10).map(({selfUs,...row})=>({...row,selfMs:ms(selfUs)})),events:inside};
    });
}

/** Call after selecting an AWAKE mock agent and opening Files. No send/newline. */
export async function measureTypingBurst({client, ev, outDir, target, label, characters=200}) {
    if (!['composer','terminal'].includes(target)) throw new Error('target must be composer or terminal');
    if (!Number.isInteger(characters) || characters<200) throw new Error('typing requires at least 200 characters');
    if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('label must be a simple artifact filename');
    const selector=target==='composer'?'#command-input':'#xterm-container .xterm-helper-textarea';
    const context=await ev(`(async()=>{const {state}=await import((window.__coralStatic||'/static/')+'state.js');const s=state.currentSession;const x=${JSON.stringify(target)}==='terminal'?await import((window.__coralStatic||'/static/')+'xterm_renderer.js'):null;const el=document.querySelector(${JSON.stringify(selector)}),files=document.getElementById('changed-files-list'),side=document.getElementById('live-sessions-list');return {session:s?{id:s.session_id,server:s.server,type:s.type,sleeping:!!s.sleeping}:null,live:state.liveSessions.length,awake:state.liveSessions.filter(s=>!s.sleeping&&!s.archived).length,input:!!el&&!el.disabled&&el.getClientRects().length>0,filesVisible:!!files&&files.getClientRects().length>0,sidebarVisible:!!side&&side.getClientRects().length>0,terminalConnected:x?x.isTerminalWsOpen():null};})()`);
    if (!context.session || context.session.sleeping || !context.input || !context.filesVisible || !context.sidebarVisible || (target==='terminal'&&!context.terminalConnected)) throw new Error('Invalid live typing setup: '+JSON.stringify(context));
    const focused=await ev(`(() => {const el=document.querySelector(${JSON.stringify(selector)});${target==='composer'?"el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));":''}el.focus();window.__typingLongTasks=[];window.__typingObserver=new PerformanceObserver(list=>window.__typingLongTasks.push(...list.getEntries().map(e=>({startMs:e.startTime,ms:e.duration}))));window.__typingObserver.observe({type:'longtask',buffered:false});return document.activeElement===el;})()`);
    if (!focused) { await ev(`window.__typingObserver?.disconnect();true`); throw new Error('Typing target did not receive keyboard focus'); }
    const {Tracing,Profiler,Input}=client;
    const events=[];let truncated=false;let terminalInput='';
    const collect=({value})=>{if(events.length+value.length>300000){truncated=true;return;}events.push(...value);};
    const sent=e=>{try{const data=JSON.parse(e.response.payloadData);if(data.type==='terminal_input')terminalInput+=data.data||'';}catch{}};
    client.on('Tracing.dataCollected',collect);client.on('Network.webSocketFrameSent',sent);
    let tracing=false,profiling=false,profile=null;
    const stopTrace=async()=>{if(!tracing)return;const complete=new Promise(resolve=>client.once('Tracing.tracingComplete',resolve));await Tracing.end();await complete;tracing=false;};
    const text='the quick brown fox 0123456789 '.repeat(Math.ceil(characters/31)).slice(0,characters);
    const latencies=[];let longTasks=[];
    try {
        await Profiler.enable();await Profiler.setSamplingInterval({interval:1000});await Profiler.start();profiling=true;
        await Tracing.start({categories:'toplevel,devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing,v8',transferMode:'ReportEvents'});tracing=true;
        const startMs=await ev(`performance.mark('coral-typing-start').startTime`);
        for(const ch of text){const start=Date.now();await Input.dispatchKeyEvent({type:'keyDown',key:ch,text:ch});await Input.dispatchKeyEvent({type:'keyUp',key:ch});await ev(`new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Typing frame timeout')),10000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve(true);}));})`);latencies.push(Date.now()-start);}
        const endMs=await ev(`performance.mark('coral-typing-end').startTime`);
        longTasks=await ev(`window.__typingLongTasks.concat(window.__typingObserver.takeRecords().map(e=>({startMs:e.startTime,ms:e.duration})))`);
        longTasks=longTasks.filter(t=>t.startMs<endMs && t.startMs+t.ms>startMs);
        await stopTrace();profile=(await Profiler.stop()).profile;profiling=false;
        if(target==='composer' && !await ev(`document.querySelector('#command-input').value===${JSON.stringify(text)}`))throw new Error('Composer did not receive every synthetic character');
        if(target==='terminal' && !terminalInput.includes(text))throw new Error('Terminal input was not observed on the live WebSocket');
        if(truncated)throw new Error('Trace event cap reached; attribution incomplete');
        const marker=events.find(e=>e.name==='coral-typing-start');
        const begin=marker?.ts,end=events.find(e=>e.name==='coral-typing-end')?.ts;
        if(!Number.isFinite(begin)||!Number.isFinite(end))throw new Error('Trace is missing typing boundary markers');
        const rendererKnown=events.some(e=>e.name==='thread_name'&&e.args?.name==='CrRendererMain'&&e.pid===marker.pid&&e.tid===marker.tid);
        const rendererTaskCount=events.filter(e=>e.pid===marker.pid&&e.tid===marker.tid&&/(?:^|::)RunTask$/.test(e.name)&&['X','B'].includes(e.ph)).length;
        const traceComplete=rendererKnown&&rendererTaskCount>0;
        const tasks=summarizeTypingTrace(events,profile).filter(t=>t.startUs<end&&t.endUs>begin);
        const sorted=[...latencies].sort((a,b)=>a-b),pct=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
        const result={label,target,characters,context,keyToFrameMs:{p50:pct(.5),p95:pct(.95),max:Math.max(...latencies)},longTasks:longTasks.filter(t=>t.ms>50),traceLongTasks:tasks,traceComplete,rendererTaskCount,budgetPassed:traceComplete&&!tasks.length&&!longTasks.some(t=>t.ms>50),profiled:true};
        fs.mkdirSync(outDir,{recursive:true});
        fs.writeFileSync(path.join(outDir,label+'.trace.json.gz'),gzipSync(JSON.stringify({traceEvents:events})));
        fs.writeFileSync(path.join(outDir,label+'.cpuprofile'),JSON.stringify(profile));
        fs.writeFileSync(path.join(outDir,label+'.json'),JSON.stringify(result,null,2));
        return result;
    } finally {
        await stopTrace().catch(()=>{});if(profiling)await Profiler.stop().catch(()=>{});
        client.removeListener('Tracing.dataCollected',collect);client.removeListener('Network.webSocketFrameSent',sent);
        await ev(`window.__typingObserver?.disconnect();true`).catch(()=>{});
    }
}
