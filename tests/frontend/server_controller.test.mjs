import assert from 'node:assert/strict';
import { createServerController, serverSources } from '../../coral-go/pkg/frontend/static/server_controller.js';
const response = (body, status=200) => ({ok:status<400,status,json:async()=>body});
for (const kind of ['registered','cloud']) {
    const rows=[{id:'west',label:'West'}], events=[];
    let callback, allowed=true, calls=0, reply=response(kind==='cloud'?{servers:rows}:rows);
    const c=createServerController(serverSources[kind], {
        accept:r=>events.push(['rows',r]), fail:e=>events.push(['error',e]), render:()=>events.push(['render']), canRefresh:()=>allowed,
    }, {fetcher:async(url,init)=>{assert.equal(url,'/api/servers');if(kind==='cloud')assert.equal(init.headers.Accept,'application/json');calls++;return reply;},poll:(fn,ms)=>{assert.equal(ms,5000);callback=fn;return 12;},clear:id=>assert.equal(id,12)});
    await c.start(); assert.deepEqual(events,[['rows',rows],['render']]);
    allowed=false;callback();assert.equal(calls,1,'editing prevents polling');
    allowed=true;callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
    reply=response({error:'no permission'},403);await c.load();assert.equal(events.at(-2)[0],'error');
    c.stop();
}
// Leaving during the initial request prevents both late drawing and a new timer.
let resolveRead,draws=0,timers=0;
const pending=createServerController(serverSources.cloud,{accept:()=>draws++,fail:()=>draws++,render:()=>draws++,canRefresh:()=>true}, {
    fetcher:()=>new Promise(r=>{resolveRead=r;}),poll:()=>{timers++;return 1;},clear:()=>{},
});
const start=pending.start();pending.stop();resolveRead(response({servers:[{id:'late'}]}));await start;
assert.equal(draws,0);assert.equal(timers,0);
assert.deepEqual(serverSources.registered.rows({servers:[1]}),[]);
assert.deepEqual(serverSources.cloud.rows([1]),[]);
assert.equal(await serverSources.cloud.refused(response({},503)),'Could not load your computers.');
console.log('server_controller: both API shapes, error states, edit guard, polling teardown and late-response isolation pass');
