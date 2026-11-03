// "Open Coral on this computer" (#289) in a real browser, against the real server (no interception of Coral's own pages): the button signs a fresh browser in, and
// another site cannot use the route. Runs on a strict shard (STRICT_SUITES): there a request from this computer needs a credential, so a browser that is not signed in
// gets 401 from /api/system/status, and the button is what turns it into 200.
//   (a) another site's page POSTs a form to /auth/local: a cross-site origin, and the same host on another port (same-site). Refused (403), no redirect, no cookie.
//   (b) another site's page frames /auth: the frame is blocked (X-Frame-Options DENY, frame-ancestors 'none').
//   (c) the real button on /auth: its request carries this server's Origin and Sec-Fetch-Site same-origin, a session cookie is set, and /api/system/status goes 401 -> 200.
// Each case runs in its own new browser context (no cookie from another suite or case). The other site's pages are served by request interception at an address
// nothing listens on, so no second server is started; Coral's own requests are never intercepted.
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const { safePaused } = require('./helpers/paused');
const BASE = require('./test_base').BASE;
const { isNavigationError } = require('./helpers/wait');

const base = new URL(BASE);
// Another site: the other loopback spelling (localhost and 127.0.0.1 are different sites). The same site: this host on a port nothing listens on.
const otherHost = base.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const CROSS = `http://${otherHost}:9`;
const SAME_SITE = `http://${base.hostname}:9`;
const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: settle
const ATTACK = {
    '/post.html': `<!doctype html><meta charset="utf-8"><form id="f" method="post" action="${BASE}/auth/local"></form><script>document.getElementById('f').submit();</script>`,
    '/frame.html': `<!doctype html><meta charset="utf-8"><iframe id="fr" src="${BASE}/auth" width="600" height="400"></iframe>`,
};

(async () => {
    const port = Number(process.env.CDP_PORT || 9222);
    // The browser's own endpoint: a page's connection may not make a browser context (agent_popout's browserClient).
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await CDP({ target: info.webSocketDebuggerUrl });
    const contexts = []; const pages = [];
    console.log(`  browser: ${(await browser.Browser.getVersion()).product}`);
    // A new page in a new browser context, with the Network, Page, Runtime and Log domains on, and the other site's two pages served by interception.
    const freshPage = async () => {
        const { browserContextId } = await browser.Target.createBrowserContext({ disposeOnDetach: true });
        contexts.push(browserContextId);
        const { targetId } = await browser.Target.createTarget({ url: 'about:blank', browserContextId });
        const c = await CDP({ port, target: targetId });
        pages.push(c);
        await Promise.all([c.Page.enable(), c.Runtime.enable(), c.Network.enable(), c.Log.enable()]);
        await c.Network.setBypassServiceWorker({ bypass: true });
        await c.Fetch.enable({ patterns: [{ urlPattern: CROSS + '/*' }, { urlPattern: SAME_SITE + '/*' }] });
        safePaused(c, async p => {
            const body = ATTACK[new URL(p.request.url).pathname] || 'not found';
            return c.Fetch.fulfillRequest({ requestId: p.requestId, responseCode: body === 'not found' ? 404 : 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') });
        });
        const reqs = []; const byId = new Map(); const log = [];
        c.Network.requestWillBeSent(e => {
            // A redirect hop keeps the request's id: the answer that redirected belongs to the request before it (the 303 that follows the button's POST).
            if (e.redirectResponse && byId.has(e.requestId)) byId.get(e.requestId).status = e.redirectResponse.status;
            if (!e.request.url.startsWith(BASE)) return;
            const r = { url: e.request.url.replace(BASE, '').replace(/login_token=[^&]+/, 'login_token=<redacted>'), method: e.request.method, headers: {} };
            reqs.push(r); byId.set(e.requestId, r);
        });
        c.Network.requestWillBeSentExtraInfo(e => { const r = byId.get(e.requestId); if (r) r.headers = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])); });
        c.Network.responseReceived(e => { const r = byId.get(e.requestId); if (r) r.status = e.response.status; });
        c.on('Log.entryAdded', e => log.push(e.entry.text));
        const ev = async x => { const r = await c.Runtime.evaluate({ expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
        const waitFor = async (expr, what, ms = 8000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                let ok = false;
                try { ok = await ev(expr); } catch (e) { if (!isNavigationError(e)) throw e; }
                if (ok) return;
                await sleep(25);
            }
            throw new Error(`timed out waiting for ${what}: requests ${JSON.stringify(reqs)}`);
        };
        const cookies = async () => (await c.Network.getCookies({ urls: [BASE] })).cookies.map(k => k.name);
        const status = () => ev(`fetch('${BASE}/api/system/status', { cache: 'no-store', credentials: 'include' }).then(r => r.status)`);
        return { c, ev, waitFor, reqs, log, cookies, status };
    };
    // A condition on this side (the events Chrome sent), polled: no fixed sleep.
    const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(25); } throw new Error('timed out waiting for ' + what); };
    const shownButton = p => p.ev(`(() => { const b = document.getElementById('local-open'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.closest('[hidden]'); })()`);
    const localOpen = reqs => reqs.filter(r => r.method === 'POST' && r.url.startsWith('/auth/local'));
    let failed = 0;
    const test = async (name, fn) => {
        try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.log(`  FAIL - ${name}: ${e.message}`); }
    };
    try {
        for (const [site, sfs] of [[CROSS, 'cross-site'], [SAME_SITE, 'same-site']]) {
            await test(`another site's form POST to /auth/local is refused (${sfs})`, async () => {
                const p = await freshPage();
                await p.c.Page.navigate({ url: site + '/post.html' });
                await p.waitFor(`location.href.startsWith('${BASE}/auth/local') && document.readyState === 'complete'`, 'the form POST to land');
                await until(() => localOpen(p.reqs).some(r => r.status), 'the answer to the POST');
                const posts = localOpen(p.reqs);
                assert.equal(posts.length, 1, JSON.stringify(p.reqs));
                assert.equal(posts[0].headers['sec-fetch-site'], sfs);
                assert.equal(posts[0].status, 403, 'refused');
                assert.ok(!p.reqs.some(r => r.url.includes('login_token=')), 'no sign-in link was followed');
                assert.deepEqual(await p.cookies(), [], 'no cookie');
            });
        }
        await test('another site cannot frame /auth', async () => {
            const p = await freshPage();
            // The same site on another port: a cross-site frame runs in its own process and is not in this page's frame tree, and frame-ancestors 'none' refuses every framer.
            await p.c.Page.navigate({ url: SAME_SITE + '/frame.html' });
            await p.waitFor(`document.readyState === 'complete'`, 'the framing page');
            // Blocked: the child frame ends on Chrome's error page for /auth, never on /auth itself.
            let child = null;
            await until(async () => { const { frameTree } = await p.c.Page.getFrameTree(); child = (frameTree.childFrames || [])[0]; return !!child && (child.frame.unreachableUrl === BASE + '/auth' || child.frame.url.startsWith('chrome-error:')); }, 'the browser to block the frame');
            const auth = p.reqs.find(r => r.url === '/auth');
            assert.ok(auth, 'the frame asked for /auth');
            assert.notEqual(child.frame.url, BASE + '/auth', 'the frame never shows /auth');
        });
        // The operator's choice for #289: the button only while no password is set. Every test server starts with the runner's throwaway password (run_cdp_suites.mjs,
        // TEST_PASSWORD), so this is the state a fresh browser meets first.
        await test('with a password set, no button and the route refuses', async () => {
            const p = await freshPage();
            await p.c.Page.navigate({ url: BASE + '/auth' });
            await p.waitFor(`document.readyState === 'complete' && !!document.body`, '/auth');
            assert.equal(await shownButton(p), false, 'the button is not offered');
            assert.equal(await p.ev(`fetch('${BASE}/auth/local', { method: 'POST', credentials: 'include' }).then(r => r.status)`), 403, 'the route refuses');
            assert.deepEqual(await p.cookies(), [], 'no cookie');
        });
        // Without a password: cleared with 'coral reset-password --clear' (the runner's coral and data folder), and the runner's password set back afterwards whatever
        // happens, so the suites after this one meet the server as it was. Clearing signs every browser out, so the suite's own tab signs in again through the button.
        const coralCLI = (args, input) => require('./helpers/child_process').spawnSync(process.env.CORAL_TEST_BIN, [...args, '--url', BASE, '--home', process.env.CORAL_TEST_DATA_DIR], { encoding: 'utf8', timeout: 30000, windowsHide: true, input });
        const runnerPassword = (require('node:fs').readFileSync(require('node:path').join(__dirname, 'run_cdp_suites.mjs'), 'utf8').match(/const TEST_PASSWORD = '([^']+)'/) || [])[1];
        assert.ok(runnerPassword, "the runner's TEST_PASSWORD, to set back");
        const cleared = coralCLI(['reset-password', '--clear']);
        assert.equal(cleared.status, 0, `the password was cleared: ${(cleared.stderr || '').slice(0, 300)}`);
        try {
            let ownEv = null;
            await test("the suite's own tab signs in again through the button", async () => {
                const { targetInfos } = await browser.Target.getTargets();
                const mine = targetInfos.find(t => t.type === 'page' && !contexts.includes(t.browserContextId)); // the suite's own tab: not in a context this suite made
                assert.ok(mine, 'the suite tab');
                const own = await CDP({ port, target: mine.targetId });
                pages.push(own);
                await Promise.all([own.Runtime.enable(), own.Page.enable()]);
                const ev = async x => (await own.Runtime.evaluate({ expression: x, returnByValue: true, awaitPromise: true })).result.value;
                await own.Page.navigate({ url: BASE + '/auth' });
                await until(async () => (await ev(`!!document.getElementById('local-open') && document.readyState === 'complete'`)) === true, 'the button in the suite tab');
                await ev(`document.getElementById('local-open').click(), true`);
                await until(async () => (await ev(`location.origin === '${BASE}' && !location.pathname.startsWith('/auth') && document.readyState === 'complete'`)) === true, 'the suite tab to leave /auth', 10000);
                assert.equal(await ev(`fetch('${BASE}/api/system/status', { cache: 'no-store' }).then(r => r.status)`), 200);
                ownEv = ev;
            });
            await test('the button on /auth signs this browser in', async () => {
                const p = await freshPage();
                await p.c.Page.navigate({ url: BASE + '/auth' });
                await p.waitFor(`!!document.getElementById('local-open') && document.readyState === 'complete'`, 'the button');
                assert.equal(await p.status(), 401, 'not signed in before');
                await p.ev(`document.getElementById('local-open').click(), true`);
                await until(() => localOpen(p.reqs).some(r => r.status), 'the answer to the button request');
                const posts = localOpen(p.reqs);
                assert.equal(posts.length, 1, JSON.stringify(p.reqs.map(r => r.method + ' ' + r.url)));
                const sent = `Origin ${posts[0].headers['origin']}, Sec-Fetch-Site ${posts[0].headers['sec-fetch-site']}, answered ${posts[0].status}`;
                assert.equal(posts[0].headers['origin'], BASE, `the request names this server (${sent})`);
                assert.equal(posts[0].headers['sec-fetch-site'], 'same-origin', sent);
                assert.ok(posts[0].status < 400, `the route accepts its own button (${sent})`);
                await p.waitFor(`!location.pathname.startsWith('/auth')`, 'the page to leave /auth', 10000);
                assert.ok((await p.cookies()).length > 0, 'a session cookie is set');
                assert.equal(await p.status(), 200, 'signed in after');
            });
            // Security's extra case: with require_auth_on_loopback on, the button is not offered and the route refuses, even with no password. Changed from the suite's
            // own tab and put back as it was whatever happens: its old value, and no row at all if there was none (a PUT cannot delete a row, so the row this
            // suite added is deleted from the server's database; the live value is already back to the default by then).
            await test('with require_auth_on_loopback on, no button and the route refuses', async () => {
                assert.ok(ownEv, 'the suite tab is signed in (the case above)');
                const { sqliteText, sqliteExec } = require('./helpers/sqlite');
                const db = require('node:path').join(process.env.CORAL_TEST_DATA_DIR, 'sessions.db');
                const rowBefore = sqliteText(db, `SELECT value FROM user_settings WHERE key = 'require_auth_on_loopback'`).trim().split('\n').filter(Boolean);
                const put = v => ownEv(`fetch('${BASE}/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ require_auth_on_loopback: ${v} }) }).then(r => r.status)`);
                assert.equal(await put(true), 200, 'the setting was turned on');
                try {
                    const p = await freshPage();
                    await p.c.Page.navigate({ url: BASE + '/auth' });
                    await p.waitFor(`document.readyState === 'complete' && !!document.body`, '/auth');
                    assert.equal(await shownButton(p), false, 'the button is not offered');
                    assert.equal(await p.ev(`fetch('${BASE}/auth/local', { method: 'POST', credentials: 'include' }).then(r => r.status)`), 403, 'the route refuses');
                    assert.deepEqual(await p.cookies(), [], 'no cookie');
                } finally {
                    const old = rowBefore.length ? rowBefore[0] === 'true' : false;
                    assert.equal(await put(old), 200, 'the setting was put back');
                    if (!rowBefore.length) sqliteExec(db, `DELETE FROM user_settings WHERE key = 'require_auth_on_loopback'`);
                    const rowAfter = sqliteText(db, `SELECT value FROM user_settings WHERE key = 'require_auth_on_loopback'`).trim().split('\n').filter(Boolean);
                    assert.deepEqual(rowAfter, rowBefore, 'the settings row is as it was');
                }
            });
        } finally {
            const back = coralCLI(['reset-password', '--stdin'], runnerPassword + '\n');
            if (back.status !== 0) { failed++; console.log(`  FAIL - the runner's password was not set back: ${(back.stderr || '').slice(0, 300)}`); }
        }
    } finally {
        for (const c of pages) await c.close().catch(() => {});
        for (const id of contexts) await browser.Target.disposeBrowserContext({ browserContextId: id }).catch(() => {});
        await browser.close();
    }
    if (failed) { console.log(`auth_local_open_browser: ${failed} failed`); process.exit(1); }
    console.log('auth_local_open_browser: all passed');
})().catch(e => { console.error(e); process.exit(1); });
