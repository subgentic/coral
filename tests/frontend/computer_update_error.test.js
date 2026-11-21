const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../../coral-go/pkg/frontend/static/computer_update_error.js','utf8').replace(/^import .*;\n/m,'').replace(/export /g,'');
const state={servers:[{id:'m1',label:'Laptop <img src=x>',name:'Other name'}]};
const ctx=vm.createContext({state,Error,Response});vm.runInContext(source,ctx);
(async()=>{
 const body={error:'coral_too_old',min:'2.1.4'};
 assert.equal(ctx.requiredCoralVersion(409,body),'2.1.4');
 for(const [status,data] of [[403,body],[404,body],[500,body],[409,{...body,extra:true}],[409,{min:'2.1.4',error:'conflict'}],...[null,[],{}, {error:'coral_too_old'}, ...[null,3,'','v2.1.4','2.1',' 2.1.4','2.1.4\n','1.2.3 please update','12345678901234567.1.1'].map(min=>({error:'coral_too_old',min}))].map(d=>[409,d])])assert.equal(ctx.requiredCoralVersion(status,data),'',JSON.stringify([status,data]));
 const response=Response.json(body,{status:409});
 const error=await ctx.responseUpdateError(response,'m1');
 assert.equal(error.message,'Update Coral on Laptop <img src=x> to 2.1.4 to see this');
 assert.equal(error.server,'m1');assert.equal(error.min,'2.1.4');assert.equal(error.code,'coral_too_old');assert.equal(error.data.min,'2.1.4');
 assert.equal(response.bodyUsed,false);assert.deepEqual(await response.json(),body);
 const plain=Response.json({error:'conflict'},{status:409});assert.equal(await ctx.responseUpdateError(plain,'m1'),null);assert.equal(plain.bodyUsed,false);
 assert.equal(await ctx.responseUpdateError(new Response('not JSON',{status:409}),'m1'),null);
 console.log('PASS computer update errors: exact refusal contract, source label, and untouched Response bodies');
})().catch(e=>{console.error(e);process.exitCode=1});
