// The default permission mode when nothing is saved (#7620, from the 169 real-Codex check): the field shows Auto, and
//   - nothing saved: the select shows its own first option, "Not set (Auto)", chosen, with the line "Nothing is saved: new agents use Auto." and no warning;
//   - a Save that never touched it leaves it unset (#5836); picking Auto is a real change from Not set and is saved, after which the line "Agents cannot start workers in this mode." shows (#7587);
//   - once a mode is saved the Not set option is not offered (a saved mode is not cleared from this select).
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
  const save = () => ev(`Promise.resolve(window.applySettings()).then(()=>true)`);
  const pick = mode => ev(`(()=>{const s=document.getElementById('settings-permission-mode');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));return s.value;})()`);
  const line = () => ev(`(()=>{const w=document.querySelector('#settings-permission-mode').closest('.settings-row, .sv-row').querySelector('.perm-mode-warn');return {shown:!w.hidden&&w.getBoundingClientRect().height>0,select:document.getElementById('settings-permission-mode').value};})()`);
  const guard = await require('./helpers/settings_guard').guardSettings();
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    await ev(`new Promise(r=>{const t=setInterval(()=>{if(window.__coralStatic||document.readyState==='complete'){clearInterval(t);r(true)}},50)})`);

    const state = () => ev(`(()=>{const s=document.getElementById('settings-permission-mode');const row=s.closest('.settings-row, .sv-row');const w=row.querySelector('.perm-mode-warn');return {value:s.value,notSet:[...s.options].some(o=>o.value===''),first:s.options[0].textContent,mode:row.querySelector('.perm-mode-desc').textContent,warn:!w.hidden&&w.getBoundingClientRect().height>0};})()`);
    assert.equal(await put({ default_permission_mode: '' }), 200, 'nothing saved to start with');
    assert.equal(await saved(), '');
    await openDialog();
    assert.deepEqual(await state(), { value: '', notSet: true, first: 'Not set (Auto)', mode: 'Nothing is saved: new agents use Auto.', warn: false }, 'unset: "Not set (Auto)" is chosen, with its line and no warning');
    assert.equal(await ev(`!!document.getElementById('settings-permission-mode').closest('.settings-row, .sv-row').querySelector('.perm-mode-compare')`), false, 'the three modes are not a second line under the select: the contrast is in the row\'s More (#10266, was #10000\'s line)');
    assert.deepEqual(await ev(`(() => { const a = document.getElementById('settings-permission-mode').closest('.settings-row, .sv-row').querySelector('a.sv-learn'); return a && [a.getAttribute('href'), a.textContent, a.hasAttribute('data-route')]; })()`), ['/docs/how-do-i', 'Learn more', true], 'and its Learn more is a link into Docs, to the answer that says what Default, Auto and Not set are (#10765), not a box behind Settings');
    await save();
    assert.equal(await saved(), '', 'a Save that never touched the select leaves it unset');

    await openDialog();
    await pick('auto');
    assert.deepEqual(await state(), { value: 'auto', notSet: true, first: 'Not set (Auto)', mode: 'Everything; safety checks on Claude only.', warn: true }, 'picking Auto shows its own line and the warning at once');
    await save();
    assert.equal(await saved(), 'auto', 'picking Auto from Not set is a real change, and it is saved');
    await openDialog();
    assert.deepEqual(await state(), { value: 'auto', notSet: false, first: 'Default', mode: 'Everything; safety checks on Claude only.', warn: true }, 'a saved Auto: no Not set option, and the warning line');

    await pick('default'); await save();
    assert.equal(await saved(), 'default', 'Default is saved');
    await openDialog();
    assert.deepEqual(await state(), { value: 'default', notSet: false, first: 'Default', mode: "Asks before acting (each CLI's normal mode)", warn: false }, 'a saved Default shows no warning and still has no Not set option');

    console.log('PASS settings permission mode save');
  } finally { await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message))); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
