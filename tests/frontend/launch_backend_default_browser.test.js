// The Backend select in the Terminal step starts on the backend the server runs (#16409): a pty server shows PTY, not tmux (the first option). The status is stubbed so the test does not depend on the server's backend.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        for (const {running, server} of [{running: 'pty', server: 'local'}, {running: 'tmux', server: 'local'}, {running: 'pty', server: 'backend-remote'}]) {
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/system/terminal-backend') && !(o && o.method && o.method !== 'GET') ? Promise.resolve(new Response(JSON.stringify({ running: ${JSON.stringify(running)}, saved: ${JSON.stringify(running)}, next: ${JSON.stringify(running)}, forced: false, choice: true }), { headers: { 'content-type': 'application/json' } })) : f(u, o); return true; })()`);
            await ev(`(async () => {
                const {state} = await import((window.__coralStatic || '/static/') + 'state.js');
                state.hub = true; state.servers = [{id:'backend-remote', name:'Remote computer', status:'online'}];
                const f = window.fetch; window.__backendRequests = [];
                window.fetch = (u,o) => {
                    const url = String(u);
                    if (url.includes('/api/system/terminal-backend')) {
                        window.__backendRequests.push(url);
                        const running = url.startsWith('/api/remote/backend-remote/') ? 'pty' : ${JSON.stringify(server === 'local' ? running : 'tmux')};
                        return Promise.resolve(new Response(JSON.stringify({running, next:running}), {headers:{'content-type':'application/json'}}));
                    }
                    if (url.startsWith('/api/remote/backend-remote/')) return Promise.resolve(new Response('{}', {headers:{'content-type':'application/json'}}));
                    return f(u,o);
                };
                window.showLaunchModal(${JSON.stringify(server)}, true); return true;
            })()`);
            await waitFor(`!!document.querySelector('#launch-step-chooser [data-arg="terminal"]')`, 'the Terminal card', 8000);
            await ev(`document.querySelector('#launch-step-chooser [data-arg="terminal"]').click(); true`);
            await waitFor(`document.getElementById('launch-step-terminal').style.display !== 'none'`, 'the Terminal step', 6000);
            await waitFor(`document.getElementById('launch-terminal-backend').value === ${JSON.stringify(running)}`, `Backend shows ${running} on a ${running} server`, 4000);
            assert.equal(await ev(`document.getElementById('launch-terminal-backend').value`), running);
            assert.ok((await ev(`window.__backendRequests`)).includes(server === 'local' ? '/api/system/terminal-backend' : '/api/remote/backend-remote/api/system/terminal-backend'), 'backend status comes from the selected computer');
        }
        console.log('PASS the Terminal step Backend follows the server');
    } finally { await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
