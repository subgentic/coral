// #17135: Appearance offers built-in themes before the custom color editor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
 const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
 const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR,{recursive:true}); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from((await Page.captureScreenshot({format:'png'})).data,'base64')); };
 try {
  await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({source:PRELOAD});
  await Emulation.setDeviceMetricsOverride({width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await Emulation.setEmulatedMedia({features:[{name:'prefers-color-scheme',value:'light'}]});
  await Page.navigate({url:BASE}); await Page.loadEventFired(); await install(); await coralReady(ev,'startup','liveList','settings');
  await ev(`localStorage.setItem('coral-theme','light'); document.documentElement.dataset.theme='light'; window.__appearanceSaves=[]; { const real=window.fetch; window.fetch=(u,o={})=>{ if(new URL(String(u),location.href).pathname==='/api/settings' && /PUT|POST/.test(o.method||'')){ window.__appearanceSaves.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}})); } return real(u,o); }; } true`);
  await ev(`document.querySelector('[aria-controls="top-bar-settings-menu"]').click(); true`);
  await waitFor(`document.getElementById('top-bar-settings-menu')?.getClientRects().length`, 'Settings menu');
  await shot('1280-menu');
  const label = await ev(`(() => { const b=[...document.querySelectorAll('#top-bar-settings-menu button')].find(b=>/Appearance|Themes/.test(b.textContent)); const label=b.textContent.trim(); b.click(); return label; })()`);
  await waitFor(`['settings-modal','theme-configurator-modal'].some(id=>{const e=document.getElementById(id);return e&&getComputedStyle(e).display==='flex';})`, 'Appearance destination'); await ev(framesJs(3));
  await shot('1280-destination');
  assert.equal(label,'Appearance','menu names the simple appearance controls');
  await waitFor(`document.getElementById('settings-theme')?.getClientRects().length`, 'Theme control visible');
  assert.equal(await ev(`document.getElementById('settings-theme').closest('.settings-pane').dataset.title`),'Appearance');
  assert.deepEqual(await ev(`[...document.getElementById('settings-theme').options].slice(0,3).map(o=>o.textContent)`),['Dark','Light','System']);
  for(const theme of ['dark','light','system']){
   await ev(`{ const e=document.getElementById('settings-theme'); e.value='${theme}'; e.dispatchEvent(new Event('change',{bubbles:true})); } true`);
   await waitFor(`window.__appearanceSaves.some(s=>s.theme==='${theme}') && !document.getElementById('settings-theme').disabled`, 'Theme saved '+theme);
   assert.equal(await ev(`document.documentElement.dataset.theme`),theme==='system'?'light':theme);
  }
  await Emulation.setEmulatedMedia({features:[{name:'prefers-color-scheme',value:'dark'}]});
  await waitFor(`document.documentElement.dataset.theme==='dark'`, 'System follows OS');
  await ev(`document.querySelector('#settings-modal .settings-theme-btn').click(); true`);
  await waitFor(`getComputedStyle(document.getElementById('theme-configurator-modal')).display==='flex'`, 'Custom theme editor still available');
  console.log('PASS Appearance menu, built-in theme saves, System OS changes and custom editor');
 } finally { await client.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
