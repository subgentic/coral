// Download in the native app (#9894): the webview drops <a download> and blob: addresses, so coral-app's script (cmd/coral-app/downloads.go) sends the click to the app's native save and the dashboard says
// where the file went. Chrome stands in for the webview: the app's own script text is read from the Go source and run first, with a stand-in for the token-checked native (window._coralSaveFile) and the
// page's native flag. The person's click is a real mouse press (CDP), the script's is a.click() on a link that is not in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

const SOURCE = fs.readFileSync(path.join(__dirname, '../../coral-go/cmd/coral-app/downloads.go'), 'utf8');
const SCRIPT = SOURCE.slice(SOURCE.indexOf('`', SOURCE.indexOf('const downloadInterceptScript')) + 1, SOURCE.lastIndexOf('`'));
assert.ok(/coral:native-download/.test(SCRIPT), "the app's script was read from downloads.go");

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        // before the page's own scripts: the native flag, the stand-in native save, and the app's download script
        await Page.addScriptToEvaluateOnNewDocument({ source: `window.__CORAL_APP__ = true; window.__saved = []; window.__told = []; window.addEventListener('coral:native-download', e => window.__told.push(e.detail)); window._coralSaveFile = async (name, b64) => { window.__saved.push([name, atob(b64)]); return '/tmp/dl/' + name; };\n${SCRIPT}` });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        const before = await ev(`location.pathname`);
        // the person's click on <a download> (the Download button of an artifact is one)
        await ev(`(() => { const a = document.createElement('a'); a.id = 'dl-test'; a.href = '/api/health'; a.setAttribute('download', 'health.json'); a.textContent = 'Download'; a.style.cssText = 'position:fixed;left:20px;top:20px;width:120px;height:32px;z-index:99999;background:#fff;color:#000'; document.body.append(a); return true; })()`);
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 60, y: 36 });
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: 60, y: 36, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 60, y: 36, button: 'left', clickCount: 1 });
        await waitFor(`window.__saved.length === 1`, 'the click reached the native save', 8000);
        const first = await ev(`window.__saved[0]`);
        assert.equal(first[0], 'health.json', 'saved under its own name');
        assert.ok(/ok|status/i.test(first[1]), 'with the bytes the server answered: ' + first[1].slice(0, 80));
        await waitFor(`[...document.querySelectorAll('.toast, .notification-toast')].some(t => /Saved to Downloads: health\\.json/.test(t.textContent))`, 'the toast says where it went', 6000);
        assert.equal(await ev(`location.pathname`), before, 'the page did not navigate away');
        // a script's click on a link that is not in the page (how the exports and the manifest download work): a blob: address
        await ev(`(() => { const blob = new Blob(['{"a":1}'], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'export.json'; a.click(); return true; })()`);
        await waitFor(`window.__saved.length === 2`, 'a script click on a blob link reached the native save', 8000, `window.__told`);
        assert.deepEqual(await ev(`window.__saved[1]`), ['export.json', '{"a":1}'], 'the blob content, under its name');
        // a link that is not a download is left alone
        await ev(`(() => { const a = document.createElement('a'); a.href = '#plain'; a.id = 'plain'; a.click(); return true; })()`);
        await ev(`new Promise(r => setTimeout(r, 300))`); // sleep-ok: a wrongly intercepted link would have been saved by now
        assert.equal(await ev(`window.__saved.length`), 2, 'a link that is not a download is not saved');
        // the app says why when the save fails
        await ev(`window._coralSaveFile = async () => { throw new Error('the Downloads folder is not writable'); }; document.getElementById('dl-test').click(); true`);
        await waitFor(`[...document.querySelectorAll('.toast, .notification-toast')].some(t => /Could not save the download: the Downloads folder is not writable/.test(t.textContent))`, 'a failed save is said', 6000);
        console.log('PASS the native app saves a download: the click, a blob link, the refusal said');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
