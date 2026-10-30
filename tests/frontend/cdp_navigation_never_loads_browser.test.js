// The #6195 preload hands a suite a load that came before loadEventFired() was asked for. It must never answer for a page that has not loaded: a page whose body never finishes has no load event, and a wait for it
// must still run out (here a 3 s race), whether or not an earlier page's load went unasked just before.
// Known limit, measured: an unasked load less than a second old also answers a wait for a load the PAGE starts itself (location.assign) before its frameStartedLoading is heard.
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('./helpers/child_process');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const heard = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

(async () => {
    const sockets = new Set();
    const stall = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<!doctype html><title>stalled</title><p>the body never ends'); });
    stall.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise(r => stall.listen(0, '127.0.0.1', r));
    const STALL = `http://127.0.0.1:${stall.address().port}/`;
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    try {
        await Page.enable(); await Runtime.enable();
        // 1. a page that never finishes loading is not heard
        await heard(Page.navigate({ url: STALL }), 5000);
        check('a page whose body never ends has no load to hear', !(await heard(Page.loadEventFired(), 3000)));

        // 2. an earlier page's load, unasked a moment ago, does not answer for the next navigate
        await Page.navigate({ url: BASE + '/static/theme_init.js' });
        await sleep(300); // sleep-ok: the first page has loaded and nobody asked: the load the preload remembers
        await heard(Page.navigate({ url: STALL + '?2' }), 5000);
        check('an unasked load, then a navigate to a page that never loads: the wait is not answered', !(await heard(Page.loadEventFired(), 3000)));

        // 3. a load a wait already heard is not kept for the next wait: the pattern `const loaded = Page.loadEventFired(); await Page.navigate(...); await loaded;` (servers_table's open(): about:blank, then the page)
        const blank = Page.loadEventFired(); await Page.navigate({ url: 'about:blank' }); await blank;
        const next = Page.loadEventFired(); // asked before its navigate, straight after a load that was heard: it is for the page that follows
        await heard(Page.navigate({ url: STALL + '?4' }), 5000);
        check('a wait made before its navigate is not answered by the load the last wait heard', !(await heard(next, 3000)));

        // 4. a wait for a load that never comes is not open-ended (#352): it rejects at the limit, naming the page. With the preload's limit taken out it waits for good, and this check fails
        require('./helpers/keep_page_visible').loadLimit(2000, 'this suite waits on purpose for a page that never loads');
        await heard(Page.navigate({ url: STALL + '?5' }), 5000);
        const t0 = Date.now();
        const end = await Promise.race([Page.loadEventFired().then(() => 'a load came', e => e.message), sleep(6000).then(() => 'still waiting after 6 s')]); // sleep-ok: the bound of the race, not a wait: the rejection answers it first
        check('a wait for a page that never loads rejects at the limit, naming the page', /^\[cdp\] load timeout: no load event for http:\/\/127\.0\.0\.1:\d+\/\?5 within 2000 ms/.test(end) && Date.now() - t0 >= 1900, end);

        // 5-7. the browser going away, or the suite leaving, is not a pass (#352, QA and Security on #168): a child suite with the preload waits on its own tab for a page that never loads.
        // With the preload's disconnect handler and exit check taken out, cases 5 and 6 exit 0.
        const child = async (mode, url, { closeTab = false } = {}) => {
            const tab = await CDP.New({ port: Number(process.env.CDP_PORT || 9222) });
            const p = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'keep_page_visible.js'), path.join(__dirname, 'fixtures', 'load_wait_child.js'), mode],
                { env: { ...process.env, LOAD_WAIT_TARGET: tab.id, LOAD_WAIT_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', err = '';
            p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
            const exited = new Promise(r => p.on('exit', code => r(code)));
            if (closeTab) { for (let i = 0; i < 100 && !/waiting/.test(out); i++) await sleep(50); await sleep(300); await CDP.Close({ port: Number(process.env.CDP_PORT || 9222), id: tab.id }); } // sleep-ok: the child is waiting before its tab goes
            const code = await Promise.race([exited, sleep(20000).then(() => 'still running after 20 s')]); // sleep-ok: the bound of the race, not a wait: the child's exit answers it first
            if (code === 'still running after 20 s') p.kill();
            if (!closeTab) await CDP.Close({ port: Number(process.env.CDP_PORT || 9222), id: tab.id }).catch(() => {});
            return { code, out, err: err.trim() };
        };
        let r = await child('wait', STALL + '?6', { closeTab: true });
        check('a suite whose browser tab goes away during a load wait exits non-zero, saying so', r.code !== 0 && /\[cdp\] the browser connection closed while waiting for a load of http:\/\/127\.0\.0\.1:\d+\/\?6/.test(r.err), JSON.stringify(r));
        r = await child('exit', STALL + '?7');
        check('a suite that exits with a load wait open exits non-zero, saying so', r.code !== 0 && /\[cdp\] the suite exited with a load of http:\/\/127\.0\.0\.1:\d+\/\?7 still awaited/.test(r.err), JSON.stringify(r));
        r = await child('raced', STALL + '?8');
        check('a suite that raced a load wait, closed its client and exited 0 still exits 0', r.code === 0 && !/\[cdp\]/.test(r.err), JSON.stringify(r));
    } finally { await client.close(); for (const s of sockets) s.destroy(); stall.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} never-loads checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
