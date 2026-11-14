// An HTML file with scripts that uses localStorage works in the artifact viewer (#16735): the in-memory storage shim in artifact_host.html
// gives the sandboxed file working localStorage and sessionStorage without allow-same-origin. Nothing the file writes appears in the dashboard's
// own storage. The "Run scripts" button is visible even after the notice is hidden (the offer row is its own element, not inside the notice).
// Real Chrome against an isolated Coral. The artifact, trust and versions routes are stubbed; the real viewer, artifact_scripts.js and artifact_host.html.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const TODO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Todo</title>
<style>body{font-family:sans-serif;padding:16px}ul{list-style:none;padding:0}li{padding:4px 0}</style></head>
<body><h1>Todo</h1><input id="inp" placeholder="Add item"><button id="add">Add</button><ul id="list"></ul>
<script>
var KEY = 'coral-test-todo-items';
function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch(e) { return []; } }
function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); }
function render() { var items = load(); var ul = document.getElementById('list'); ul.innerHTML = '';
  items.forEach(function(t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); }
document.getElementById('add').addEventListener('click', function() {
  var v = document.getElementById('inp').value.trim(); if (!v) return;
  var items = load(); items.push(v); save(items); document.getElementById('inp').value = ''; render(); });
render();
document.body.setAttribute('data-ready', 'true');
</script></body></html>`;
const HEX = crypto.createHash('sha256').update(TODO_HTML).digest('hex');

(async () => {
    const { client, Page, Runtime, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const evalIn = async (sessionId, frameId, expr) => {
        const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId, worldName: 'probe-' + Date.now() }, sessionId);
        const r = await client.send('Runtime.evaluate', { contextId: executionContextId, expression: expr, returnByValue: true }, sessionId);
        return r.result.value;
    };
    const childFrame = async (expr) => {
        const { targetInfos } = await client.Target.getTargets();
        const iframes = targetInfos.filter(t => t.type === 'iframe');
        const host = iframes.find(t => /artifact_host\.html/.test(t.url));
        if (!host) return undefined;
        const { sessionId } = await client.Target.attachToTarget({ targetId: host.targetId, flatten: true });
        try {
            await client.send('Page.enable', {}, sessionId);
            const { frameTree } = await client.send('Page.getFrameTree', {}, sessionId);
            const child = (frameTree.childFrames || [])[0];
            return child ? await evalIn(sessionId, child.frame.id, expr) : undefined;
        } finally { await client.Target.detachFromTarget({ sessionId }).catch(() => {}); }
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        // stub the artifact and trust routes
        await ev(`(() => {
            window.__trust = new Set(); window.__body = ${JSON.stringify(TODO_HTML)}; window.__bodyHex = ${JSON.stringify(HEX)};
            const orig = window.fetch.bind(window);
            const json = (o, s = 200) => Promise.resolve(new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }));
            window.fetch = (u, o) => { const url = String(u), method = (o && o.method) || 'GET';
                const t = /\\/api\\/artifacts\\/([a-f0-9]{64})\\/trust-preview/.exec(url);
                if (t) { if (method === 'PUT') window.__trust.add(t[1]); if (method === 'DELETE') window.__trust.delete(t[1]);
                    return json({ id: t[1], trusted: window.__trust.has(t[1]) }); }
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}\\/(versions|comments)/.test(url)) return json(/comments/.test(url) ? { comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} } : []);
                if (/\\/api\\/artifacts\\/[a-f0-9]{64}/.test(url)) return Promise.resolve(new Response(window.__body, { status: 200, headers: { 'Content-Type': 'text/html' } }));
                return orig(u, o); };
        })()`);
        // plant a sentinel in the dashboard's own localStorage to prove isolation
        await ev(`localStorage.setItem('coral-test-todo-items', 'DASHBOARD'); true`);
        const open = async () => {
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close')?.click(); true`);
            await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${HEX}', { filename: 'todo.html', mediaType: 'text/html', sourceNamed: false })).then(() => true)`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, 'the HTML preview', 10000);
        };
        const q = sel => ev(`(() => { const e = document.querySelector('#artifact-viewer ${sel}'); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
        const click = sel => ev(`document.querySelector('#artifact-viewer ${sel}').click(); true`);

        // 1. the offer is visible even after the notice hides (the button is in its own row, not inside the notice)
        await open();
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, 'the Run scripts offer', 5000);
        // simulate the notice being hidden (as syncSandbox does after the first view)
        await ev(`(() => { const n = document.querySelector('#artifact-viewer .artifact-linked-notice'); if (n) n.hidden = true; return true; })()`);
        assert.ok(await q('.artifact-scripts-ask'), 'Run scripts button is visible after the notice is hidden');
        await shot('todo-offer-visible');

        // 2. trust, run scripts, the todo page loads and uses localStorage
        await click('.artifact-scripts-ask');
        await click('.artifact-scripts-go');
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-bar')`, 'the Scripts are on bar', 10000);
        // wait for the todo page to be ready inside the sandboxed frame
        for (let i = 0; i < 200; i++) {
            const ready = await childFrame(`document.body && document.body.getAttribute('data-ready')`);
            if (ready === 'true') break;
            await sleep(50);
        }
        assert.equal(await childFrame(`document.body.getAttribute('data-ready')`), 'true', 'the todo page loaded and ran its script');
        // the frame's localStorage works (the shim)
        const storageWorks = await childFrame(`(() => { try { localStorage.setItem('test', 'hello'); return localStorage.getItem('test'); } catch(e) { return 'ERROR: ' + e.message; } })()`);
        assert.equal(storageWorks, 'hello', 'localStorage works inside the sandboxed frame via the shim');
        // add an item through the todo page's UI
        await childFrame(`(() => { document.getElementById('inp').value = 'Buy milk'; document.getElementById('add').click(); return true; })()`);
        await sleep(100);
        const items = await childFrame(`document.querySelectorAll('#list li').length`);
        assert.equal(items, 1, 'the todo page added an item: ' + items);
        const text = await childFrame(`document.querySelector('#list li').textContent`);
        assert.equal(text, 'Buy milk', 'the todo item reads back correctly');
        await shot('todo-running');

        // 3. nothing the file wrote leaks to the dashboard's own localStorage
        const dashboard = await ev(`localStorage.getItem('coral-test-todo-items')`);
        assert.equal(dashboard, 'DASHBOARD', 'the dashboard localStorage was not touched by the sandboxed file: got ' + dashboard);
        // the file's localStorage key exists only in the shim, not in the dashboard
        const leaked = await ev(`localStorage.getItem('coral-test-todo-items') !== 'DASHBOARD'`);
        assert.equal(leaked, false, 'no storage leak from the sandboxed frame to the dashboard');

        // 4. the ⋯ menu item also works after the notice is hidden (#16735: the offer row is not inside the notice)
        await ev(`window.__trust.clear()`);
        await open();
        await waitFor(`!!document.querySelector('#artifact-viewer .artifact-scripts-ask')`, 'the offer again', 5000);
        await ev(`(() => { const n = document.querySelector('#artifact-viewer .artifact-linked-notice'); if (n) n.hidden = true; return true; })()`);
        await ev(`document.querySelector('#artifact-viewer .artifact-viewer-more').click(); true`);
        const menuItem = await ev(`(() => { const item = document.querySelector('#artifact-viewer .artifact-viewer-scripts-item'); return item ? item.textContent.trim() : null; })()`);
        assert.equal(menuItem, 'Run scripts…', 'the menu offers Run scripts while they are off');
        await click('.artifact-viewer-scripts-item');
        assert.ok(await q('.artifact-scripts-sure'), 'the menu opens the confirmation even with the notice hidden');

        // cleanup
        await ev(`localStorage.removeItem('coral-test-todo-items'); true`);
    } finally { await client.close(); }
    console.log('artifact_scripts_todo_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
