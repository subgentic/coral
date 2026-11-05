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
        assert.ok(browserContextId, 'the case owns a new browser context');
        contexts.push(browserContextId);
        const { targetId } = await browser.Target.createTarget({ url: 'about:blank', browserContextId });
        assert.ok(targetId, 'the case owns an exact page target');
        const c = await CDP({ port, target: targetId });
        pages.push(c);
        await Promise.all([c.Page.enable(), c.Runtime.enable(), c.Network.enable(), c.Log.enable()]);
        await c.Network.setBypassServiceWorker({ bypass: true });
        await c.Fetch.enable({ patterns: [{ urlPattern: CROSS + '/*' }, { urlPattern: SAME_SITE + '/*' }] });
        safePaused(c, async p => {
            const body = ATTACK[new URL(p.request.url).pathname] || 'not found';
            return c.Fetch.fulfillRequest({ requestId: p.requestId, responseCode: body === 'not found' ? 404 : 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') });
        });
        const reqs = []; const hops = new Map(); const log = [];
        // One request id carries every hop of a redirect (the button's POST, then the 303's GET), and the events of a hop do not arrive in a fixed order, nor do the hops' extra infos: Network.requestWillBeSentExtraInfo (the
        // headers the browser REALLY sent: Origin, Sec-Fetch-*) of the GET hop can come BEFORE the POST's (trial-251 gate: the POST read the GET's headers, 'Origin undefined, answered 303'). So the hops of an id are a list in
        // order (a hop outside this server is kept as a placeholder so the order holds), the extra infos of an id are kept apart and ordered by the time their request was sent (connectTiming.requestTime), and they are handed to
        // the hops only when there is one for every hop and the last hop has its answer: a hop's headers are never read before they are its own. A case waits for r.sent as well as the status.
        // CDP_EXTRA_REORDER_MS delays the FIRST extra info of every id by that many ms (the test of this collector: the old assignment fails with it set, this one passes).
        const extras = new Map();
        const settle = id => {
            const list = hops.get(id) || [], ex = extras.get(id) || [];
            if (!list.length || ex.length !== list.length || list[list.length - 1].status === undefined) return;
            const ordered = [...ex].sort((x, y) => (x.time || 0) - (y.time || 0));
            list.forEach((r, i) => { r.headers = ordered[i].headers; r.sent = true; });
        };
        c.Network.requestWillBeSent(e => {
            const list = hops.get(e.requestId) || []; hops.set(e.requestId, list);
            if (e.redirectResponse && list.length) list[list.length - 1].status = e.redirectResponse.status; // the answer that redirected belongs to the hop before it
            const mine = e.request.url.startsWith(BASE);
            const r = { url: e.request.url.replace(BASE, '').replace(/login_token=[^&]+/, 'login_token=<redacted>'), method: e.request.method, headers: {}, outside: !mine };
            list.push(r);
            if (mine) reqs.push(r);
            settle(e.requestId);
        });
        const delayFirst = Number(process.env.CDP_EXTRA_REORDER_MS || 0);
        c.Network.requestWillBeSentExtraInfo(e => {
            const keep = () => { const ex = extras.get(e.requestId) || []; extras.set(e.requestId, ex); ex.push({ headers: Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v])), time: e.connectTiming && e.connectTiming.requestTime }); settle(e.requestId); };
            if (delayFirst && !(extras.get(e.requestId) || []).length && !(extras.get('late:' + e.requestId))) { extras.set('late:' + e.requestId, true); setTimeout(keep, delayFirst); } else keep();
        });
        c.Network.responseReceived(e => { const list = hops.get(e.requestId); const r = list && list[list.length - 1]; if (r) { r.status = e.response.status; settle(e.requestId); } });
        c.on('Log.entryAdded', e => log.push(e.entry.text));
        const ev = async x => { const r = await c.Runtime.evaluate({ expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)); return r.result.value; };
        const waitFor = async (expr, what, ms = 8000) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                let ok = false;
                try { ok = await ev(expr); } catch (e) { if (!isNavigationError(e)) throw new Error(e.message + '; page ' + await diagnostics({ targetId, ev })); }
                if (ok) return;
                await sleep(25);
            }
            throw new Error(`timed out waiting for ${what}: requests ${JSON.stringify(reqs.map(({url,method,status})=>({url,method,status})))}; targets ${await diagnostics({ targetId, ev })}`);
        };
        const cookies = async () => (await c.Network.getCookies({ urls: [BASE] })).cookies.map(k => k.name);
        const status = () => ev(`fetch('${BASE}/api/system/status', { cache: 'no-store', credentials: 'include' }).then(r => r.status)`);
        return { c, targetId, browserContextId, ev, waitFor, reqs, log, cookies, status, authRenavigations: 0 };
    };
    // Queries/hashes may carry sign-in credentials: timeout evidence needs target
    // identity and origin/path only, never those credentials.
    const safeUrl = raw => { try { const u = new URL(raw); u.search = ''; u.hash = ''; return ['http:', 'https:', 'about:'].includes(u.protocol) ? u.href : u.protocol + '<omitted>'; } catch { return '<unavailable>'; } };
    const pageState = async page => {
        try {
            const [at, included, omitted] = await page.ev(`Promise.all([
                Promise.resolve({url:location.href,title:document.title}),
                fetch('${BASE}/api/system/status',{cache:'no-store',credentials:'include',signal:AbortSignal.timeout(3000)}).then(r=>r.status).catch(()=>null),
                fetch('${BASE}/api/system/status',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(3000)}).then(r=>r.status).catch(()=>null)
            ])`);
            return { url: safeUrl(at.url), title: at.title, includedStatus: included, cookieLessStatus: omitted };
        } catch { return { url: '<unavailable>', title: '<unavailable>', includedStatus: null, cookieLessStatus: null }; }
    };
    const diagnostics = async (page, state = null) => {
        const { targetInfos } = await browser.Target.getTargets();
        return JSON.stringify({ targetId: page.targetId, ...(state || await pageState(page)), targets: targetInfos.map(t => ({ targetId: t.targetId, type: t.type, url: safeUrl(t.url), browserContextId: t.browserContextId, attached: t.attached })) });
    };
    // A condition on this side (the events Chrome sent), polled: no fixed sleep.
    const until = async (fn, what, ms = 8000, page = null) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch (e) { if (!isNavigationError(e)) throw e; } await sleep(25); } throw new Error('timed out waiting for ' + what + (page ? ': targets ' + await diagnostics(page) : '')); };
    const shownButton = p => p.ev(`(() => { const b = document.getElementById('local-open'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.closest('[hidden]'); })()`);
    const localOpen = reqs => reqs.filter(r => r.method === 'POST' && r.url.startsWith('/auth/local'));
    // Observe readiness and click in the SAME evaluate. The module can enable
    // the button and then navigate away when loopback is open: a separate CDP
    // readiness check followed by a click races that intended redirect.
    const clickLocalOpen = async p => {
        const deadline = Date.now() + 30000;
        for (let attempt = 0; attempt < 2; attempt++) {
            let result = null, error = null;
            try {
                const cap = Math.max(1, Math.min(15000, deadline - Date.now()));
                result = await p.ev(`new Promise(resolve => {
                    let observer, timer;
                    const finish = value => { observer?.disconnect(); clearTimeout(timer); document.removeEventListener('readystatechange',check); resolve(value); };
                    const check = () => {
                        const b = document.getElementById('local-open');
                        if (b && document.documentElement.dataset.authReady === 'true' && !b.disabled) { b.click(); finish(true); return true; }
                        if (!b && document.readyState === 'complete') { finish(location.href); return true; }
                        return false;
                    };
                    if (check()) return;
                    observer = new MutationObserver(check);
                    observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-auth-ready','disabled']});
                    document.addEventListener('readystatechange',check);
                    timer = setTimeout(()=>finish(location.href),${cap});
                })`);
            } catch (e) { error = e; }
            if (result === true) return;
            const state = await pageState(p);
            console.log('  local-open miss: ' + await diagnostics(p,state));
            // A navigation can destroy the evaluate after its click already
            // issued the POST. Never click twice in that case.
            if (localOpen(p.reqs).length > 0) return;
            if (state.includedStatus === 200 && state.cookieLessStatus === 401) throw new Error('session still alive after reset-password --clear: ' + await diagnostics(p,state));
            let leftAuth = false;
            for (const raw of [result,state.url]) { try { const u = new URL(raw); leftAuth ||= u.origin === base.origin && !u.pathname.startsWith('/auth'); } catch { /* no usable URL */ } }
            if (attempt === 0 && p.authRenavigations < 1 && (leftAuth || (error && isNavigationError(error))) && Date.now() < deadline) { p.authRenavigations++; await p.c.Page.navigate({url:BASE+'/auth'}); continue; }
            if (error && !isNavigationError(error)) throw error;
            throw new Error('local-open was not clicked within its two-navigation cap: ' + await diagnostics(p,state));
        }
    };
    // Capture every pre-click assertion together, after the cookie-less status
    // read. A separate awaited fetch must not leave a stale note-element lookup.
    const localOpenProof = async p => {
        const deadline = Date.now() + 30000;
        for (let attempt = 0; attempt < 2; attempt++) {
            let snapshot = null, error = null;
            try {
                await p.waitFor(`(location.origin === '${BASE}' && !location.pathname.startsWith('/auth')) || (document.documentElement?.dataset.authReady === 'true' && !!document.getElementById('local-open'))`, 'the auth handler or its redirect', Math.max(1,deadline-Date.now()));
                snapshot = await p.ev(`(async () => {
                    const cookieLessStatus = await fetch('${BASE}/api/system/status',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(3000)}).then(r=>r.status);
                    return {authReady:document.documentElement?.dataset.authReady === 'true',buttonPresent:!!document.getElementById('local-open'),note:document.getElementById('local-open-note')?.textContent ?? null,href:location.href,cookieLessStatus};
                })()`);
            } catch (e) { error = e; }
            if (snapshot?.authReady && snapshot.buttonPresent && snapshot.note !== null) return snapshot;
            const state = await pageState(p);
            console.log('  local-open proof miss: ' + await diagnostics(p,state) + '; exception: ' + (error?.message || 'missing auth button/note'));
            if (state.includedStatus === 200 && state.cookieLessStatus === 401) throw new Error('session still alive after reset-password --clear: ' + await diagnostics(p,state));
            let leftAuth = false;
            for (const raw of [snapshot?.href,state.url]) { try { const u = new URL(raw); leftAuth ||= u.origin === base.origin && !u.pathname.startsWith('/auth'); } catch { /* no usable URL */ } }
            if (attempt === 0 && p.authRenavigations < 1 && (leftAuth || (error && isNavigationError(error))) && Date.now() < deadline) { p.authRenavigations++; await p.c.Page.navigate({url:BASE+'/auth'}); continue; }
            throw new Error('auth button/note proof missing before click: ' + (error?.message || JSON.stringify(snapshot)) + '; page ' + await diagnostics(p,state));
        }
    };
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
                await until(() => localOpen(p.reqs).some(r => r.status && r.sent), 'the answer to the POST');
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
                // Own an exact target in a fresh context. A leftover page from an
                // earlier strict suite can have the same BASE URL, so neither
                // URL matching nor target-list order identifies this case.
                const p = await freshPage();
                const { c: own, ev } = p;
                await own.Page.navigate({ url: BASE + '/auth' });
                await clickLocalOpen(p);
                await until(() => localOpen(p.reqs).some(r => r.status), 'the suite tab button POST', 30000, p);
                assert.equal(localOpen(p.reqs).length, 1, 'the suite tab clicks once');
                assert.ok(localOpen(p.reqs)[0].status < 400, 'the suite tab button POST succeeds');
                await until(async () => (await ev(`location.origin === '${BASE}' && !location.pathname.startsWith('/auth') && document.readyState === 'complete'`)) === true, 'the suite tab to leave /auth', 30000, p);
                assert.equal(await ev(`fetch('${BASE}/api/system/status', { cache: 'no-store' }).then(r => r.status)`), 200);
                ownEv = ev;
            });
            await test('the button on /auth signs this browser in', async () => {
                const p = await freshPage();
                await p.c.Page.navigate({ url: BASE + '/auth' });
                if (process.env.CORAL_TEST_STRICT !== '1') { console.log('  skipped here: only a strict shard (the runner sets CORAL_TEST_STRICT=1 there) gives this browser a 401 to turn into a 200; the strict shard asserts it'); return; } // the default-mode run of a STRICT_SUITES suite (#12907, Security's SHOULD: the skip depends on the shard, not on the answer)
                const proof = await localOpenProof(p);
                assert.equal(proof.cookieLessStatus, 401, 'not signed in before (cookie-less): ' + JSON.stringify(proof));
                const promised = proof.note; // one snapshot: no DOM access after an awaited status request
                assert.ok(/asks you to create a password/i.test(promised) && !/without a password/i.test(promised), 'the note says the password prompt comes next, and promises no way around it: ' + promised);
                await clickLocalOpen(p);
                await until(() => localOpen(p.reqs).some(r => r.status && r.sent), 'the answer to the button request');
                const posts = localOpen(p.reqs);
                assert.equal(posts.length, 1, JSON.stringify(p.reqs.map(r => r.method + ' ' + r.url)));
                const sent = `Origin ${posts[0].headers['origin']}, Sec-Fetch-Site ${posts[0].headers['sec-fetch-site']}, answered ${posts[0].status}`;
                assert.equal(posts[0].headers['origin'], BASE, `the request names this server (${sent})`);
                assert.equal(posts[0].headers['sec-fetch-site'], 'same-origin', sent);
                assert.ok(posts[0].status < 400, `the route accepts its own button (${sent})`);
                await p.waitFor(`!location.pathname.startsWith('/auth')`, 'the page to leave /auth', 30000);
                assert.ok((await p.cookies()).length > 0, 'a session cookie is set');
                assert.equal(await p.status(), 200, 'signed in after');
                await p.waitFor(`!!document.getElementById('set-password-modal')`, 'the password prompt the note said would come', 20000); // #12834: and it does
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
        // Closing is bounded: a CDP call whose answer never comes (a page or context that is already gone, a browser that exits first) used to hang the suite for the runner's whole 180 s after the last case had printed ok
        // (trial-248, run 41897148416: all 7 ok, then "[runner] TIMEOUT"). `.catch` only handles a rejection, never a silence, so each step races a short timer, and the suite ends with an explicit exit below.
        const bounded = p => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, 5000).unref())]); // sleep-ok: the bound on a close that may never answer, not a wait for the page
        for (const c of pages) await bounded(c.close());
        for (const id of contexts) await bounded(browser.Target.disposeBrowserContext({ browserContextId: id }));
        await bounded(browser.close());
    }
    if (failed) { console.log(`auth_local_open_browser: ${failed} failed`); process.exit(1); }
    console.log('auth_local_open_browser: all passed');
    process.exit(0); // nothing is left to wait for: a socket or timer still open must not keep the runner waiting
})().catch(e => { console.error(e); process.exit(1); });
