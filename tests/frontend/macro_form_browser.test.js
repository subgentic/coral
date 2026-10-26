// The Add Macro dialog is a settings_view in form mode (#7908): label above the control, both fields Required, the primary always enabled, and pressing it checks the form:
// the first invalid field takes the focus and the status line says what is missing. A valid form saves the macro and closes. Enter in a field submits. Cancel empties it.
// The shard's own macros are put back at the end.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
  const { Page, Runtime, Input } = client;
  const ev = async expression => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const MOD = `(window.__coralStatic||'/static/')`;
  const macros = async () => JSON.parse((await ev(`fetch('/api/settings').then(r=>r.json()).then(d=>d.settings)`)).macros || '[]');
  const state = () => ev(`(() => { const m = document.getElementById('macro-modal'); const a = document.activeElement; const bar = document.querySelector('#macro-footer .sv-status');
    return { open: getComputedStyle(m).display !== 'none', focus: a && a.id, status: bar ? bar.textContent : null, role: bar ? bar.getAttribute('role') : null,
      invalid: [...m.querySelectorAll('[aria-invalid="true"]')].map(e => e.id), primaryDisabled: m.querySelector('#macro-footer .btn-primary').disabled, primary: m.querySelector('#macro-footer .btn-primary').textContent.trim() }; })()`);
  const type = async (id, text) => { await ev(`document.getElementById('${id}').focus(); true`); await Input.insertText({ text }); };
  const press = key => Input.dispatchKeyEvent({ type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0, text: key === 'Enter' ? '\r' : undefined }).then(() => Input.dispatchKeyEvent({ type: 'keyUp', key, code: key }));
  let original = {};
  const guard = await require('./helpers/settings_guard').guardSettings(); // the settings this suite changes are put back in its finally (#4849)
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    await ev(`new Promise(r=>{const t=setInterval(()=>{if(window.__coralStatic||document.readyState==='complete'){clearInterval(t);r(true)}},50)})`);
    original = await ev(`fetch('/api/settings').then(r=>r.json()).then(d=>d.settings)`);
    await ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({macros:''})}).then(r=>r.status)`);
    const before = await macros(); // the saved list as the dialog starts (the defaults when nothing is saved)
    await ev(`import(${MOD}+'controls.js').then(m=>{m.showMacroModal();return true;})`);

    console.log('1. open: label above the control, both Required, the primary enabled, nothing said yet');
    const shape = await ev(`(() => { const l = document.getElementById('macro-label-input'), c = document.getElementById('macro-command-input'); const lr = l.getBoundingClientRect(), lab = document.querySelector('label[for="macro-label-input"]').getBoundingClientRect();
      return { above: lab.bottom <= lr.top + 1, full: Math.round(lr.width) >= Math.round(l.closest('.sv-form').getBoundingClientRect().width * 0.9), req: [l, c].map(e => e.getAttribute('aria-required')), badges: document.querySelectorAll('#macro-form .sv-required').length }; })()`);
    assert.deepEqual(shape, { above: true, full: true, req: ['true', 'true'], badges: 2 }, JSON.stringify(shape));
    let s = await state();
    assert.deepEqual(s, { open: true, focus: 'macro-label-input', status: '', role: 'status', invalid: [], primaryDisabled: false, primary: 'Add' }, JSON.stringify(s));

    console.log('2. Add with nothing: the first invalid field (Label) takes the focus, the line says what is missing, nothing is saved');
    await ev(`document.querySelector('#macro-footer .btn-primary').click(); true`);
    await ev(`new Promise(r => setTimeout(r, 100))`); // sleep-ok: the click's async submit settles
    s = await state();
    assert.equal(s.focus, 'macro-label-input'); assert.deepEqual(s.invalid, ['macro-label-input', 'macro-command-input']); assert.equal(s.status, 'Label is required.');
    assert.deepEqual(await macros(), before);

    console.log('3. only the label typed: the Command field takes the focus and the line names it');
    await type('macro-label-input', 'Ship');
    await ev(`document.querySelector('#macro-footer .btn-primary').click(); true`);
    await ev(`new Promise(r => setTimeout(r, 100))`); // sleep-ok: the click's async submit settles
    s = await state();
    assert.equal(s.focus, 'macro-command-input'); assert.deepEqual(s.invalid, ['macro-command-input']); assert.match(s.status, /Command/i, s.status);

    console.log('4. Enter in the Command field submits a valid form: saved as typed, the dialog closes');
    await type('macro-command-input', '/commit && git push');
    await press('Enter');
    await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: the save and the close
    const after = await macros(); // the first add saves the list the page showed (the defaults) with the new macro last
    assert.deepEqual(after[after.length - 1], { label: 'Ship', command: '/commit && git push' }); assert.equal(after.filter(m => m.label === 'Ship').length, 1);
    s = await state(); assert.equal(s.open, false);

    console.log('5. reopened it is empty with no errors; Cancel closes it and keeps what was typed out of the next opening');
    await ev(`import(${MOD}+'controls.js').then(m=>{m.showMacroModal();return true;})`);
    s = await state();
    assert.deepEqual([s.open, s.focus, s.status, s.invalid], [true, 'macro-label-input', '', []]);
    assert.equal(await ev(`document.getElementById('macro-label-input').value + '|' + document.getElementById('macro-command-input').value`), '|');
    await type('macro-label-input', 'Half');
    await ev(`[...document.querySelectorAll('#macro-footer .btn')].find(b => b.textContent.trim() === 'Cancel').click(); true`);
    s = await state(); assert.equal(s.open, false);
    await ev(`import(${MOD}+'controls.js').then(m=>{m.showMacroModal();return true;})`);
    assert.equal(await ev(`document.getElementById('macro-label-input').value`), '');
    assert.deepEqual((await macros()).map(m => m.label), after.map(m => m.label), 'Cancel saved nothing');
    console.log('PASS Add Macro is a form: Required, first invalid focused, the primary enabled with a status line, Enter submits, Cancel empties');
  } finally {
    try {
      await ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ macros: original.macros || '' })})}).then(r=>r.status)`);
    } catch { /* the page is gone */ }
    await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
    await client.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
