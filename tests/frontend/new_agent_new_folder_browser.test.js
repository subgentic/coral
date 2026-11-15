// New agent and a folder that does not exist yet (#16351, found by a beta walk): step 1 says Coral makes a new folder at Launch, but the dialog sent create_dir for its own suggestion only, so a folder the person
// typed inside one that exists was refused at Launch with a toast, "directory not found". Now step 1 checks the typed folder as New team's does (#12833): a new folder inside one that exists gets a line that Coral makes it and
// Launch asks for exactly that (create_new_folder); a refusal at Launch is said under the Folder field (the step comes back, no toast) and goes when the path changes. The isolated dev server's own file system.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connect } = require('./agent_view_harness');
const { install: installNA, openNewAgent, stubModels, scenarios } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const S = scenarios();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-16351-'));
    const parent = path.join(root, 'work'); fs.mkdirSync(parent);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev); await stubModels(ev);
        // The launches the page sends are kept; the page's answer is a folder error unless a scenario says otherwise, so no agent starts.
        await ev(`(() => { window.__posts = []; window.__answer = null; const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname;
            if (o.method === 'POST' && p === '/api/sessions/launch') { window.__posts.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify(window.__answer || { error: 'stopped by the test' }), { status: window.__answer ? 400 : 500, headers: { 'Content-Type': 'application/json' } })); }
            return R(u, o); }; return true; })()`);
        const fill = v => ev(`(() => { const i = document.getElementById('launch-dir'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        const open = async dir => {
            await ev(`window.hideLaunchModal && window.hideLaunchModal(); for (const k of Object.keys(localStorage)) if (/recent/i.test(k)) localStorage.removeItem(k); window.__posts.length = 0; true`);
            await openNewAgent(ev, waitFor); await fill(dir);
        };
        const next = () => ev(`(() => { const b = window.__na.find('button', /^Next$/i); if (b) b.click(); return !!b; })()`);
        const stage = () => ev(`document.getElementById('launch-step-agent').dataset.stage`);
        const state = () => ev(`(() => { const l = document.getElementById('launch-dir-new'), e = document.getElementById('launch-dir-error'), i = document.getElementById('launch-dir');
            return { line: !!l && !l.hidden && l.getClientRects().length > 0, lineText: l ? l.textContent : '', error: e ? e.textContent : '', invalid: i.getAttribute('aria-invalid') === 'true', toast: (document.getElementById('notices')?.textContent || ''), create: i.dataset.createNew || '' }; })()`);

        await S.run('a new folder typed inside one that exists: step 1 says Coral makes it, and Launch asks for it', async () => {
            const dir = path.join(parent, 'beta24-b');
            await open(dir);
            await next();
            await waitFor(`document.getElementById('launch-step-agent').dataset.stage !== 'folder'`, 'the next step', 8000);
            await waitFor(`!!document.getElementById('launch-dir').dataset.createNew`, 'the check (Next does not wait for it)', 8000);
            const s = await state();
            assert.equal(s.create, dir, 'the page remembers the folder it will ask for: ' + JSON.stringify(s));
            for (let i = 0; i < 3 && (await stage()) !== 'agent'; i++) { await next(); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a step change has no event to wait on in the harness
            await ev(`(() => { const b = window.__na.find('button', /^Launch$/i); if (b) b.click(); return !!b; })()`);
            await waitFor(`window.__posts.length > 0`, 'the launch request', 8000);
            const b = await ev(`window.__posts[0]`);
            assert.equal(b.create_new_folder, true, 'it asks Coral to make the folder: ' + JSON.stringify(b));
            assert.equal(b.working_dir, dir);
            assert.ok(!b.create_dir, 'and not as the suggestion');
        });
        await S.run('the line at step 1 names the folder and where it is made', async () => {
            const dir = path.join(parent, 'beta24-c');
            await open(dir);
            await next();
            await waitFor(`!!document.getElementById('launch-dir').dataset.createNew || document.getElementById('launch-step-agent').dataset.stage !== 'folder'`, 'the check', 8000);
            await ev(`window._launchStage('folder'); true`);
            const s = await state();
            assert.ok(/beta24-c does not exist yet\. Coral creates it inside .* when you launch\./.test(s.lineText), 'the words: ' + JSON.stringify(s));
        });
        await S.run('a launch the server refuses for the folder is said under the field, with no toast, and goes when the path changes', async () => {
            await open('/tmp');
            await ev(`window.__answer = { error: 'directory not found: /tmp/x', field: 'working_dir' }; true`);
            for (let i = 0; i < 3 && (await stage()) !== 'agent'; i++) { await next(); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a step change has no event to wait on in the harness
            await ev(`(() => { const b = window.__na.find('button', /^Launch$/i); if (b) b.click(); return !!b; })()`);
            await waitFor(`window.__posts.length > 0`, 'the launch request', 8000);
            await waitFor(`!!document.getElementById('launch-dir-error')`, 'the error under the field', 8000);
            const s = await state();
            assert.ok(!/directory not found/i.test(s.toast), 'no toast carries it: ' + JSON.stringify(s.toast));
            await ev(`window._launchStage('folder'); true`);
            await fill('/tmp/other');
            await waitFor(`!document.getElementById('launch-dir-error')`, 'the error goes when the path changes', 4000);
        });
        await S.run('the beta tester\'s shape, <home>/Coral/<name> with no Coral folder yet: Launch brings the Folder field back with Create this folder (not a toast on step 3), and that launch asks for create_dir', async () => {
            const dir = path.join(root, 'Coral', 'beta24-b');
            await open(dir);
            await ev(`document.getElementById('launch-dir').dataset.coralRoot = ${JSON.stringify(root)}; window.__answer = { error: 'directory not found: ${dir}', field: 'working_dir' }; true`);
            for (let i = 0; i < 3 && (await stage()) !== 'agent'; i++) { await next(); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a step change has no event to wait on in the harness
            await ev(`(() => { const b = window.__na.find('button', /^Launch$/i); if (b) b.click(); return !!b; })()`);
            await waitFor(`!!document.querySelector('#launch-dir-error .field-error-action')`, 'the Create this folder button under the field', 8000);
            assert.equal(await stage(), 'folder', 'the Folder field is on screen');
            assert.ok(!/directory not found/i.test((await state()).toast), 'no toast');
            await ev(`window.__answer = null; window.__posts.length = 0; document.querySelector('#launch-dir-error .field-error-action').click(); true`);
            for (let i = 0; i < 4 && (await stage()) !== 'agent'; i++) { await next(); await new Promise(r => setTimeout(r, 300)); } // sleep-ok: a step change has no event to wait on in the harness
            await ev(`(() => { const b = window.__na.find('button', /^Launch$/i); if (b) b.click(); return !!b; })()`);
            await waitFor(`window.__posts.length > 0`, 'the launch request', 8000);
            assert.equal((await ev(`window.__posts[0]`)).create_dir, true, 'the server makes it whole');
        });
        S.finish();
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} await client.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
