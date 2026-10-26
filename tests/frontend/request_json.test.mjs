import assert from 'node:assert/strict';
import { requestJson } from '../../coral-go/pkg/frontend/static/request_json.js';
const original=globalThis.fetch;
let reply, seen;
globalThis.fetch=async (url, init)=>{seen={url,init};return reply;};
const response=(status,text)=>({ok:status>=200&&status<300,status,text:async()=>text});
try {
    reply=response(200,'{"value":1}');
    assert.deepEqual(await requestJson('GET','/x'),{value:1});
    assert.deepEqual(seen,{url:'/x',init:{method:'GET'}});
    reply=response(204,'');
    assert.deepEqual(await requestJson('POST','/x',{a:1}),{});
    assert.deepEqual(seen.init,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"a":1}'});
    await requestJson('POST','/x',null); assert.equal(seen.init.body,'null');
    for(const [status,text,message,data] of [[403,'{"error":"denied","why":1}','denied',{error:'denied',why:1}],[502,'<html>bad</html>','HTTP 502',{}],[409,'null','HTTP 409',{}],[404,'{"error":42}','HTTP 404',{error:42}]]) {
        reply=response(status,text);
        await assert.rejects(requestJson('GET','/x'),e=>e.message===message&&e.status===status&&assert.deepEqual(e.data,data)===undefined);
    }
    reply=response(200,'bad json'); await assert.rejects(requestJson('GET','/x'),SyntaxError);
    reply={ok:true,status:200,text:async()=>{throw Error('body gone');}};
    assert.deepEqual(await requestJson('GET','/x'),{});
    const network=Error('offline');globalThis.fetch=async()=>{throw network;};
    await assert.rejects(requestJson('GET','/x'),e=>e===network);
} finally {globalThis.fetch=original;}
console.log('request_json: body, empty response, server errors, invalid JSON and network failures preserved');
