// Settings > Security has one Accounts row for Claude and Pi (#11293 row 13, Pi Tester's v2.0.7 pass; one row since #11320): its Check asks Pi (GET /api/system/cli-check?type=pi&signin=1) and says signed in, not signed in,
// or that it could not tell, naming the provider the answer is for (Pi signs in per provider). The route is stood in. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
        await ev(`(() => { const R = window.fetch; window.__asks = []; window.__answer = {};
            window.fetch = (u, o) => { const url = new URL(String(u && u.url || u), location.href);
                if (url.pathname === '/api/system/cli-check' && url.searchParams.get('signin') === '1') { window.__asks.push(url.search); return Promise.resolve(new Response(JSON.stringify(window.__answer), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);
        await ev(`(async () => { await window.showSettingsModal('security'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-accounts-check')`, 'the Accounts row');
        const labels = await ev(`[...document.querySelectorAll('#settings-modal .sv-label, #settings-modal label, #settings-modal .sv-row-label')].map(e => e.textContent.trim())`);
        assert.ok(labels.includes('Accounts') && !labels.includes('Pi account') && !labels.includes('Claude account'), 'one Accounts row, a line for Claude and a line for Pi: ' + JSON.stringify(labels));
        assert.deepEqual(await ev(`[...document.querySelectorAll('#settings-accounts .account-name')].map(e => e.textContent)`), ['Claude', 'Pi'], 'a line per provider');
        assert.equal(await ev(`document.getElementById('settings-accounts-check').getAttribute('aria-label')`), 'Check Claude and Pi sign-in');
        const check = async answer => { await ev(`window.__answer = ${JSON.stringify(answer)}; document.getElementById('settings-accounts-check').click(); true`); await waitFor(`document.getElementById('settings-pi-account-status').textContent !== 'Checking...' && document.getElementById('settings-pi-account-status').textContent !== ''`, 'the answer'); return ev(`document.getElementById('settings-pi-account-status').textContent`); };
        assert.equal(await check({ found: true, signed_in: true, provider: 'openai' }), 'Signed in to openai');
        assert.equal(await check({ found: true, signed_in: false, provider: 'anthropic' }), 'Not signed in to anthropic: start pi and run /login');
        assert.equal(await check({ found: true, signed_in: true }), 'Signed in', 'no provider named: nothing invented');
        assert.match(await check({ found: true, signin_timeout: true }), /^Could not tell if Pi is signed in/);
        assert.equal(await ev(`window.__asks.length`), 8, 'each Check asks Claude and Pi (4 Checks)');
        assert.ok((await ev(`window.__asks`)).every(q => /type=(pi|claude)/.test(q) && /source=settings_check/.test(q)) && (await ev(`window.__asks`)).filter(q => /type=pi/.test(q)).length === 4, 'asked for Pi once each time, with the Settings analytics source');
        // while it asks the Check is aria-disabled, not disabled (a disabled button drops the keyboard to the page, #11323: the state is read in the click's own turn, before the answers)
        assert.deepEqual(await ev(`(() => { const b = document.getElementById('settings-accounts-check'); b.click(); return [b.disabled, b.getAttribute('aria-disabled')]; })()`), [false, 'true'], 'Check is aria-disabled while it asks, never disabled');
        await waitFor(`document.getElementById('settings-pi-account-status').textContent !== 'Checking...' && !document.getElementById('settings-accounts-check').hasAttribute('aria-disabled')`, 'the answer');
        // the keyboard stays on the Check button through and after the check (a disabled button dropped it to the page, #11323)
        await ev(`document.getElementById('settings-accounts-check').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await new Promise(r => setTimeout(r, 120)); // sleep-ok: the Check is asking: a disabled button would have lost the focus by now
        assert.equal(await ev(`document.activeElement.id`), 'settings-accounts-check', 'the focus stays on Check while it asks (a key pressed on it)');
        await waitFor(`document.getElementById('settings-pi-account-status').textContent !== 'Checking...'`, 'the answer');
        assert.equal(await ev(`document.activeElement.id`), 'settings-accounts-check', 'and after it answers');
        // 320 px at 200% text (#11323): the answer drops under the provider's name and stays a few lines, not a column of single words
        await Emulation.setDeviceMetricsOverride({ width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
        await ev(`document.documentElement.style.setProperty('font-size', '32px', 'important'); window.__answer = { found: true, signed_in: false, provider: 'anthropic' }; document.getElementById('settings-accounts-check').click(); true`);
        await waitFor(`/^Not signed in/.test(document.getElementById('settings-pi-account-status').textContent)`, 'the answer at 320');
        const g = await ev(`(() => { const r = e => e.getBoundingClientRect(), lines = [...document.querySelectorAll('#settings-accounts .account-line')].map(l => { const n = l.querySelector('.account-name'), s = l.querySelector('.settings-hint'); return { stacked: r(s).top >= r(n).bottom - 1, h: Math.round(r(s).height), lh: parseFloat(getComputedStyle(s).lineHeight) || 24, w: Math.round(r(s).width), box: Math.round(r(l).width) }; }); return { lines, sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
        assert.ok(g.lines.every(l => l.stacked && l.h <= l.lh * 5 && l.w >= l.box * 0.6) && !g.sideways, 'at 320 px and 200% text each answer is under its provider and wide enough: ' + JSON.stringify(g));
        console.log('PASS the Pi account row');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
