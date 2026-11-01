const assert = require('node:assert/strict');
const fs = require('node:fs');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT) });
  const { Page, Runtime } = client;
  const ev = async expression => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    await ev(`import((window.__coralStatic||'/static/')+'modals.js')`);
    await ev(`(() => { document.body.innerHTML='<main><div id="fixture"></div></main>'; window.fetch=async url => { const u=String(url); if(u.includes('/api/settings')) return new Response(JSON.stringify({settings:{default_model_claude:'claude-opus-5',default_model_codex:'gpt-6-sol'}})); if(u.includes('/api/agents/models')) return new Response(JSON.stringify({agent_type:'claude',models:[],refreshing:false})); if(u.includes('/api/agent-models')) return new Response(JSON.stringify({claude:['claude-opus-5'],codex:['gpt-6-sol'],agy:[],pi:[]})); return new Response('{}'); }; for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k); window.__coral._invalidateDefaultModels?.(); })()`);
    const change = async (value, type) => ev(`(async()=>{ window.renderAgentConfigForm('fixture',{value:{agentType:${JSON.stringify(type)},model:${JSON.stringify(value)}}}); await new Promise(r=>setTimeout(r,120)); const s=document.querySelector('.acf-agent-type'); s.value=${JSON.stringify(type === 'claude' ? 'codex' : 'claude')}; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,120)); return {type:s.value,model:document.querySelector('.acf-model').value,dirty:document.getElementById('fixture').dataset.acfModelDirty}; })()`);
    const claudeToCodex = await change('claude-opus-5','claude');
    assert.deepEqual(claudeToCodex,{type:'codex',model:'gpt-6-sol',dirty:'false'});
    const codexToClaude = await change('gpt-6-sol','codex');
    assert.deepEqual(codexToClaude,{type:'claude',model:'claude-opus-5',dirty:'false'});
    const unchanged = await ev(`(async()=>{window.renderAgentConfigForm('fixture',{value:{agentType:'codex',model:'gpt-6-sol'}});await new Promise(r=>setTimeout(r,120));document.querySelector('.acf-agent-type').dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,120));return {type:document.querySelector('.acf-agent-type').value,model:document.querySelector('.acf-model').value};})()`);
    assert.deepEqual(unchanged,{type:'codex',model:'gpt-6-sol'});
    const custom = await change('my-custom-codex-model','claude');
    assert.deepEqual(custom,{type:'codex',model:'gpt-6-sol',dirty:'false'}); // a model typed under Claude is Claude's (#11786): Codex shows its own default
    const back = await ev(`(async()=>{const s=document.querySelector('.acf-agent-type'); s.value='claude'; s.dispatchEvent(new Event('change',{bubbles:true})); await new Promise(r=>setTimeout(r,120)); // sleep-ok: the form's model default fetch and redraw, as in the steps above
    return {type:s.value,model:document.querySelector('.acf-model').value,dirty:document.getElementById('fixture').dataset.acfModelDirty}; })()`);
    assert.deepEqual(back,{type:'claude',model:'my-custom-codex-model',dirty:'true'}); // and back on Claude it returns
    // a model picked from Claude's list is Claude's own: away to Codex and back, the default that was on its way when the person returned does not replace it (#11786)
    const picked = await ev(`(async()=>{ const wait = async f => { for (let i = 0; i < 150 && !f(); i++) await new Promise(r => setTimeout(r, 20)); }, f = document.getElementById('fixture'), R = window.fetch;
        window.fetch = async (url, o) => String(url).includes('/api/agents/models') && String(url).includes('type=claude') ? new Response(JSON.stringify({agent_type:'claude',models:[{value:'claude-mid'}],refreshing:false})) : R(url, o);
        for (const k of Object.keys(localStorage)) if (k.startsWith('coral-models:v1:')) localStorage.removeItem(k);
        window.renderAgentConfigForm('fixture',{value:{agentType:'claude'}}); await wait(() => f.dataset.acfDefaults === 'ready' && [...f.querySelectorAll('.acf-model-select option')].some(o => o.value === 'claude-mid'));
        const sel = f.querySelector('.acf-model-select'); sel.value = 'claude-mid'; sel.dispatchEvent(new Event('change',{bubbles:true}));
        const t = f.querySelector('.acf-agent-type'); t.value = 'codex'; t.dispatchEvent(new Event('change',{bubbles:true})); await wait(() => f.dataset.acfDefaults === 'ready');
        t.value = 'claude'; t.dispatchEvent(new Event('change',{bubbles:true})); await wait(() => f.dataset.acfDefaults === 'ready'); await new Promise(r => setTimeout(r, 50));
        window.fetch = R; return {type:t.value,model:f.querySelector('.acf-model').value}; })()`);
    assert.deepEqual(picked,{type:'claude',model:'claude-mid'});
    fs.writeFileSync(require('node:os').tmpdir() + '/coral-1492-provider-switch.png', Buffer.from((await Page.captureScreenshot()).data,'base64'));
    console.log(JSON.stringify({claudeToCodex,codexToClaude,unchanged,custom,back}));
  } finally { await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
