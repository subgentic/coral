// New agent starts at step 1 with a folder and a Launch button (#10034, Desktop tester #10030 fix 1): the folder is the last one used, else this computer's scratch folder; Launch is in the footer of step 1; the
// button that goes on to the persona, prompt and permissions is called Advanced and still leads there. A launch from step 1 sends that folder. 1280 and 390 px, isolated dev server, the launch request stubbed.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    const shot = require('./helpers/scene_shots')(Page, 'new-agent-start');
    const folder = () => ev(`(() => { const i = window.__na.find('input', ${N.folder}); return i ? i.value : null; })()`);
    const btn = rx => ev(`(() => { const e = window.__na.find('button', ${rx}); return e ? { ...window.__na.box(e), disabled: !!e.disabled } : null; })()`);
    const reopen = async () => { await ev(`window.hideLaunchModal && window.hideLaunchModal(); { const d = document.getElementById('launch-dir'); if (d) d.value = ''; } true`); await openNewAgent(ev, waitFor); };
    const recents = list => ev(`localStorage.setItem('coral-recent-dirs', ${JSON.stringify(JSON.stringify(list))}); true`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await installNA(ev);
        await ev(`(() => { const R = window.__qaRealFetch || (window.__qaRealFetch = window.fetch); window.__launches = [];
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
                if (url.pathname === '/api/sessions/launch' && (o.method || 'GET').toUpperCase() === 'POST') { window.__launches.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stubbed' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); }
                return R(u, o); }; return true; })()`);

        await S.run('with a folder used before, New agent opens with it, and Launch is on step 1', async () => {
            await recents(['/work/payments-app', '/work/website']); await reopen();
            assert.equal(await folder(), '/work/payments-app', 'the last folder used is in the field');
            const go = await btn(N.launch); assert.ok(go && !go.disabled, 'Launch is in the footer of step 1 and on');
            assert.ok(/Step 1 of 3/.test(await ev(`window.__na.dialog().textContent`)), 'still step 1');
            await shot('step1-1280-last-folder');
        });
        await S.run('with none used, the folder is this computer\'s scratch folder', async () => {
            await recents([]); await reopen();
            const f = await folder(), scratch = await ev(`document.body.dataset.scratchDir`);
            assert.ok(scratch && /coral-scratch$/.test(scratch), 'the page knows the scratch folder: ' + scratch);
            assert.equal(f, scratch, 'the field holds it');
            await shot('step1-1280-scratch');
        });
        await S.run('Launch on step 1 sends the folder; Advanced goes to the persona and Launch stays', async () => {
            await recents(['/work/payments-app']); await reopen();
            assert.ok(await btn(/^Advanced$/), 'a button named Advanced replaces Next on step 1');
            assert.ok(!(await btn(/^Next$/)), 'no Next on step 1');
            await ev(`window.__na.find('button', ${N.launch}).click(); true`);
            await waitFor(`window.__launches.length === 1`, 'the launch request', 6000);
            assert.equal(await ev(`window.__launches[0].working_dir`), '/work/payments-app', 'it launches in the folder in the field');
            await ev(`window.__na.find('button', /^Advanced$/).click(); true`);
            await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, 'step 2', 4000);
            assert.ok(await btn(/^Next$/), 'step 2 has Next'); assert.ok(await btn(N.launch), 'Launch stays on step 2');
        });
        await S.run('a folder already in the field is selected on focus (typing replaces it), every recent folder is the field\'s list, and a blocked Launch says why on step 1', async () => {
            await recents(['/work/payments-app', '/work/website', '/work/docs', '/work/old']); await reopen();
            const sel = await ev(`(() => { const i = window.__na.find('input', ${N.folder}); i.blur(); i.focus(); return { s: i.selectionStart, e: i.selectionEnd, n: i.value.length }; })()`);
            assert.ok(sel.n > 0 && sel.s === 0 && sel.e === sel.n, `the text is selected: ${JSON.stringify(sel)}`);
            const opts = await ev(`(() => { const i = window.__na.find('input', ${N.folder}); const l = i.list; return l ? [...l.options].map(o => o.value) : null; })()`);
            assert.deepEqual(opts, ['/work/payments-app', '/work/website', '/work/docs', '/work/old'], 'all recents are offered as a list');
            await ev(`(() => { const d = document.createElement('div'); d.id = 'qa-block'; d.setAttribute('data-blocks-launch', ''); d.textContent = 'Claude is not installed on this computer.'; document.getElementById('launch-step-agent').append(d); d.dispatchEvent(new Event('cli-blocks-launch', { bubbles: true })); return true; })()`);
            assert.equal((await btn(N.launch)).disabled, true, 'Launch is off');
            assert.match(await ev(`document.getElementById('launch-agent-status').textContent`), /Claude is not installed/, 'the reason is said on the step');
            await ev(`document.getElementById('qa-block').remove(); document.dispatchEvent(new Event('cli-blocks-launch')); true`);
        });
        await S.run('390 px: Launch is inside the screen on step 1', async () => {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
            await recents(['/work/payments-app']); await reopen();
            const go = await btn(N.launch); assert.ok(go && !go.disabled, 'Launch is there and on (a launch that failed earlier does not leave it off)');
            assert.ok(await ev(`/btn-primary/.test(window.__na.find('button', ${N.launch}).className) && !/btn-primary/.test(window.__na.find('button', /^Advanced$/).className)`), 'on step 1 Launch is the one primary button; Advanced is the quiet one');
            assert.ok(go.x >= 0 && go.x + go.w <= 390 && go.y + go.h <= 844, `Launch is on screen: ${JSON.stringify(go)}`);
            assert.ok(await btn(/^Advanced$/), 'Advanced is there too');
            await ev(`document.querySelectorAll('.toast').forEach(e => e.remove()); true`); // the stubbed launch's error toast is not part of the picture
            await shot('step1-390');
        });
        S.finish();
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
