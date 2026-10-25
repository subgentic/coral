// The default permission mode when nothing is saved (#7620, from the 169 real-Codex check): the field shows Auto, and
//   - a Save that never touched it leaves it unset (a dialog saved without touching a field does not turn the default into a saved mode, #5836);
//   - a pick is saved even when it is the Auto the field showed: pick another mode, pick Auto back, Save, and Auto is saved (the person thinks it is), after which
//     the line "Agents cannot start workers in this mode." shows (#7587), and a saved Default shows none.
// Real isolated server; the shard's own setting is put back at the end by the settings guard.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
  const { Page, Runtime } = client;
  const ev = async expression => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const MOD = `(window.__coralStatic||'/static/')`;
  const put = body => ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.status)`);
  const saved = () => ev(`fetch('/api/settings').then(r=>r.json()).then(d=>d.settings.default_permission_mode || '')`);
  const openDialog = async () => { await ev(`import(${MOD}+'state.js').then(async s => { const d = await fetch('/api/settings').then(r => r.json()); s.state.settings = d.settings; return true; }).then(() => import(${MOD}+'modals.js')).then(m => m.showSettingsModal('agents')).then(() => true)`); await ev(`new Promise((res, rej) => { const t0 = Date.now(), t = setInterval(() => { const p = document.querySelector('#settings-modal .settings-pane:not([hidden])'); if (p && p.dataset.group === 'agents' && document.getElementById('settings-permission-mode')) { clearInterval(t); res(true); } else if (Date.now() - t0 > 5000) { clearInterval(t); rej(new Error('the Agents pane did not open')); } }, 50); })`); };
  const save = () => ev(`import(${MOD}+'modals.js').then(m=>m.applySettings()).then(()=>true)`);
  const pick = mode => ev(`(()=>{const s=document.getElementById('settings-permission-mode');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()`);
  const line = () => ev(`(()=>{const w=document.querySelector('#settings-permission-mode').closest('.settings-row').querySelector('.perm-mode-warn');return {shown:!w.hidden&&w.getBoundingClientRect().height>0,select:document.getElementById('settings-permission-mode').value};})()`);
  const guard = await require('./helpers/settings_guard').guardSettings();
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    await ev(`new Promise(r=>{const t=setInterval(()=>{if(window.__coralStatic||document.readyState==='complete'){clearInterval(t);r(true)}},50)})`);

    assert.equal(await put({ default_permission_mode: '' }), 200, 'nothing saved to start with');
    assert.equal(await saved(), '');
    await openDialog();
    assert.deepEqual(await line(), { shown: false, select: 'auto' }, 'unset shows Auto and no line');
    await save();
    assert.equal(await saved(), '', 'a Save that never touched the field leaves it unset');

    await openDialog();
    await pick('default'); assert.equal((await line()).shown, false, 'Default: no line');
    await pick('auto'); assert.deepEqual(await line(), { shown: true, select: 'auto' }, 'picking Auto shows the line at once');
    await save();
    assert.equal(await saved(), 'auto', 'picking Auto and pressing Save saves Auto, though the field showed Auto already');
    await openDialog();
    assert.deepEqual(await line(), { shown: true, select: 'auto' }, 'a saved Auto shows the line when the dialog opens');

    await pick('default'); await save();
    assert.equal(await saved(), 'default', 'Default is saved');
    await openDialog();
    assert.deepEqual(await line(), { shown: false, select: 'default' }, 'a saved Default shows no line');
    console.log('PASS settings permission mode save');
  } finally { await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message))); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
