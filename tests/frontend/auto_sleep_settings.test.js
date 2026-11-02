// #12111: "Put idle agents to sleep" (auto_sleep, on by default) and "Idle for N minutes" (auto_sleep_idle_minutes, 60, 15 to 1440). Both Settings loaders show them as saved and on and 60 when unset;
// Apply saves a boolean and a whole number of minutes; the real Settings dialog has them; the server refuses a value outside the range.
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
  const setup = settings => ev(`(() => {
    const boxes=['settings-telemetry-enabled','settings-remote-access-enabled','settings-debug-input-log','settings-board-auto-attach','settings-auto-resume','settings-auto-sleep'];
    document.body.innerHTML=boxes.map(id=>'<input type="checkbox" id="'+id+'">').join('')+'<input id="settings-auto-sleep-minutes" type="number">'
      +'<input id="settings-renderer-select" value="xterm">'
      +'<div id="settings-remote-access-status"></div><div id="settings-debug-input-log-status" hidden></div>'
      +'<button id="settings-debug-input-log-delete" hidden>Delete the log</button><div id="settings-modal"></div>';
    window.__settingsPut=[];
    window.fetch=async (url,opts={})=>{const u=String(url);
      if(u.endsWith('/api/settings')&&opts.method==='PUT'){window.__settingsPut.push(JSON.parse(opts.body));return new Response('{}');}
      if(u.endsWith('/api/settings'))return new Response(JSON.stringify({settings:${JSON.stringify(settings)}}));
      if(u.includes('/api/system/privacy'))return new Response(JSON.stringify({telemetry_enabled:true,remote_access_enabled:false,remote_access_effective:false,debug_input_log:{enabled:false,forced:false}}));
      if(u.includes('/api/themes/'))return new Response(JSON.stringify({theme:{base:'dark',variables:{}}}));
      return new Response('{}');};
  })()`);
  const shown = () => ev(`({ on: document.getElementById('settings-auto-sleep').checked, minutes: document.getElementById('settings-auto-sleep-minutes').value })`);
  const guard = await require('./helpers/settings_guard').guardSettings();
  try {
    await Page.enable(); await Page.navigate({ url: BASE }); await Page.loadEventFired();
    const put = body => ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.status)`);
    assert.equal(await put({ auto_sleep: 'yes' }), 400, 'the server refuses a non-boolean');
    for (const bad of [14, 1441, 'x', 60.5, 0]) assert.equal(await put({ auto_sleep_idle_minutes: bad }), 400, `the server refuses ${bad} minutes`);
    assert.equal(await put({ auto_sleep: false, auto_sleep_idle_minutes: 90 }), 200, 'the server takes a boolean and 90');
    const stored = await ev(`fetch('/api/settings').then(r=>r.json()).then(j=>{const s=j.settings||j;return [s.auto_sleep,s.auto_sleep_idle_minutes]})`);
    assert.deepEqual(stored, ['false', '90'], 'stored as "false" and "90"');
    assert.equal(await put({ auto_sleep: true, auto_sleep_idle_minutes: 60 }), 200, 'and back');

    for (const mod of ['modals.js', 'settings_core.js']) {
      for (const settings of [{}, { auto_sleep: '', auto_sleep_idle_minutes: '' }, { auto_sleep_idle_minutes: 'abc' }]) {
        await setup(settings);
        await ev(`import(${MOD}+'${mod}').then(m=>m.loadSettings())`);
        assert.deepEqual(await shown(), { on: true, minutes: '60' }, `${mod}: on and 60 when unset (${JSON.stringify(settings)})`);
      }
      await setup({ auto_sleep: 'false', auto_sleep_idle_minutes: '120' });
      await ev(`import(${MOD}+'${mod}').then(m=>m.loadSettings())`);
      assert.deepEqual(await shown(), { on: false, minutes: '120' }, `${mod}: what was saved`);
    }

    // Apply: nothing changed sends neither; a change sends a boolean and a whole number inside the range
    await setup({});
    await ev(`import(${MOD}+'modals.js').then(m=>m.loadSettings())`);
    await ev(`(async()=>{document.getElementById('settings-auto-sleep').checked=false;document.getElementById('settings-auto-sleep-minutes').value='90';await Promise.resolve(window.applySettings())})()`);
    const sent = await ev(`window.__settingsPut[0]`);
    assert.equal(sent.auto_sleep, false, 'saved as off');
    assert.equal(sent.auto_sleep_idle_minutes, '90', 'saved as 90');
    // Outside the range is said and not saved (#12328; it was sent as the nearest end, so 5 became 15 silently): no request, the field marked
    for (const bad of ['5', '99999', '14', '1441', '1e3', '0x20']) {
      const before = await ev(`window.__settingsPut.length`);
      await ev(`document.getElementById('settings-auto-sleep-minutes').type = ${JSON.stringify(/^[0-9]+$/.test(bad) ? 'number' : 'text')}`); // a number box would drop '0x20' to '' before the check sees it; the check must hold either way
      await ev(`(async()=>{document.getElementById('settings-auto-sleep-minutes').value=${JSON.stringify(bad)};await Promise.resolve(window.applySettings())})()`);
      assert.equal(await ev(`window.__settingsPut.length`), before, `${bad} is refused: no request`);
      assert.equal(await ev(`document.getElementById('settings-auto-sleep-minutes').getAttribute('aria-invalid')`), 'true', `${bad} marks the field`);
    }
    await ev(`(async()=>{document.getElementById('settings-auto-sleep-minutes').value='15';await Promise.resolve(window.applySettings())})()`);
    assert.equal(await ev(`window.__settingsPut[window.__settingsPut.length - 1].auto_sleep_idle_minutes`), '15', '15 is saved as 15');
    assert.equal(await ev(`document.getElementById('settings-auto-sleep-minutes').getAttribute('aria-invalid')`), null, 'and the mark is gone');

    // The real dialog has both, with their words.
    await Page.navigate({ url: BASE }); await Page.loadEventFired();
    const row = await ev(`(async () => {
      const m = await import(${MOD}+'modals.js');
      await m.loadSettings();
      await window.showSettingsModal();
      const box = document.getElementById('settings-auto-sleep'), min = document.getElementById('settings-auto-sleep-minutes');
      const label = box && document.getElementById(box.getAttribute('aria-labelledby'));
      return box && min ? { checked: box.checked, label: label && label.textContent.trim(), minutes: min.value, min: min.min, max: min.max } : 'missing';
    })()`);
    assert.deepEqual(row, { checked: true, label: 'Auto-sleep', minutes: '60', min: '15', max: '1440' }, 'the Settings dialog');

    console.log('PASS auto-sleep settings: on and 60 by default, shown as saved, saved as a boolean and a clamped whole number, validated');
  } finally {
    await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
    await client.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
