// One click on Save says one thing (#9785, UI/UX's look check #9773 item 9): the dialog's Save button, clicked once, leaves one toast, never "Settings saved" beside "Nothing to save".
// A fresh server has no stored settings, so the first Save writes the dialog's defaults; the second one has nothing to write. Each is one click.
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
  const until = async (expr, what, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await ev(expr)) return; await new Promise(r => setTimeout(r, 50)); } // sleep-ok: poll interval of the until helper
    throw new Error('timed out waiting for ' + what);
  };
  const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`);
  const clearToasts = () => ev(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
  const openDialog = async () => {
    await ev(`window.showSettingsModal(); true`);
    await until(`document.getElementById('settings-cli-path-claude')?.dataset.filled === '1'`, 'the dialog to finish filling');
  };
  const clickSave = async () => {
    await clearToasts();
    await ev(`document.getElementById('settings-save-btn').click(); true`);
    await until(`document.querySelectorAll('.toast').length > 0`, 'the Save toast');
    await until(`document.getElementById('settings-modal').style.display === 'none'`, 'the dialog to close');
  };
  const guard = await require('./helpers/settings_guard').guardSettings();
  try {
    await Page.enable();
    const loaded = Page.loadEventFired();
    await Page.navigate({ url: BASE + '/' });
    await loaded;
    await until(`!!window.__coralStatic || document.readyState === 'complete'`, 'the page');
    for (const [round, want] of [['first Save', /^(Saved|Settings saved|Nothing to save)/], ['second Save', /^Nothing to save/]]) {
      await openDialog();
      await clickSave();
      await ev(`new Promise(r => setTimeout(r, 400))`); // sleep-ok: a second toast from the same click would land by now
      const t = await toasts();
      assert.equal(t.length, 1, round + ' leaves one toast: ' + JSON.stringify(t));
      assert.match(t[0], want, round + ' says one thing: ' + t[0]);
    }
    console.log('PASS one click on Save, one toast');
  } finally {
    await guard.restore().catch(() => {});
    await client.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
