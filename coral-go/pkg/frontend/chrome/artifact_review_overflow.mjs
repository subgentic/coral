// Real-Chrome regression for the artifact review layout at phone and desktop widths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const chrome = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const temp = await mkdtemp(path.join(os.tmpdir(), 'artifact-review-chrome-'));
const css = name => pathToFileURL(path.join(root, 'static/css', name)).href;
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css('variables.css')}">
<link rel="stylesheet" href="${css('components.css')}">
<link rel="stylesheet" href="${css('mobile.css')}">
<link rel="stylesheet" href="${css('artifact-comments.css')}">
<link rel="stylesheet" href="${css('artifact_viewer_header.css')}">
<style>body{margin:0}.artifact-viewer{position:fixed;inset:0;display:grid;place-items:center}.artifact-viewer-content{width:95vw}.artifact-viewer-header,.artifact-review,.artifact-viewer-foot{box-sizing:border-box;width:100%}.artifact-viewer-main{width:100%;position:relative}</style>
<dialog open class="modal-content dlg-flow artifact-viewer artifact-viewer-content">
 <header class="artifact-viewer-header"><h2 class="artifact-viewer-title">home-mock-1280.png</h2><button class="btn ac-toggle">Comments</button><span class="artifact-review-state">Waiting for your review</span></header>
 <p class="artifact-viewer-source">Description with a long unbroken value: very-long-artifact-description-token-that-should-not-expand-the-review-viewer-beyond-the-screen-width.</p>
 <section class="artifact-review"><form class="artifact-review-form"><label for="review">What should change?</label><textarea id="review" rows="3"></textarea><button class="btn">Send request</button><button class="btn">Cancel</button></form></section>
 <main class="artifact-viewer-main"><div class="artifact-viewer-body">Preview</div><aside class="ac-panel ac-sheet-open"><h3>Comments</h3><p>Comments panel content</p></aside></main>
 <footer class="artifact-viewer-foot"><button class="btn">Close</button></footer>
</dialog>`;
const fixture = path.join(temp, 'review.html');
await writeFile(fixture, html);
const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.includes('DevTools listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`Chrome exited (${code}): ${stderr}`)));
  });
  const browserURL = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  assert.ok(browserURL, 'Chrome exposes its DevTools endpoint');
  const port = new URL(browserURL).port;
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextID = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); }
    if (message.method) for (const resolve of events.get(message.method) || []) resolve(message.params);
  });
  const send = (sessionId, method, params = {}) => new Promise((resolve, reject) => { const id = ++nextID; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, sessionId, method, params })); });
  const target = await send(undefined, 'Target.createTarget', { url: 'about:blank' });
  const attached = await send(undefined, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  const on = method => new Promise(resolve => { const list = events.get(method) || []; list.push(resolve); events.set(method, list); });
  await send(session, 'Page.enable');
  const loaded = on('Page.loadEventFired');
  await send(session, 'Page.navigate', { url: pathToFileURL(fixture).href });
  await loaded;
  for (const width of [390, 1280]) {
    await send(session, 'Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    const result = await send(session, 'Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const selectors = ['.artifact-viewer-content','.artifact-viewer-header','.artifact-viewer-source','.artifact-review','.artifact-review-form','.artifact-review-form button','.ac-panel'];
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        rightEdges: Object.fromEntries(selectors.map(s => [s, Math.max(...[...document.querySelectorAll(s)].map(e => e.getBoundingClientRect().right))])) };
    })()` });
    const layout = result.result.value;
    assert.equal(layout.viewport, width, `Chrome uses ${width}px viewport`);
    assert.ok(layout.scrollWidth <= width, `${width}px page has no horizontal overflow: ${layout.scrollWidth}px`);
    for (const [element, right] of Object.entries(layout.rightEdges)) assert.ok(right <= width + 1, `${element} fits at ${width}px (right edge ${right}px)`);
  }
  ws.close();
  console.log('Artifact review fits in real Chrome at 390px and 1280px.');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(temp, { recursive: true, force: true });
}
