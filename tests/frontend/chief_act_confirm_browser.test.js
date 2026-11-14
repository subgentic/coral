// #16225: entering Act asks once; cancellation restores Ask first without a PUT.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady, framesJs } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const failures = [];
    const pick = value => ev(`(() => { const e = document.querySelector('#settings-chief-host [name=chief_actions]'); e.value = '${value}'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const confirmOpen = () => ev(`document.getElementById('confirm-modal').style.display === 'flex'`);
    const shot = async name => { if (!process.env.CORAL_SCREENSHOT_DIR) return; fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch; window.__chiefValues = {chief_actions:'ask_first'}; window.__chiefWrites = [];
                const json = b => Promise.resolve(new Response(JSON.stringify(b), {headers:{'Content-Type':'application/json'}}));
                window.fetch = (u,o={}) => { const p = new URL(String(u),location.origin).pathname;
                    if (p === '/api/settings') { if (o.method === 'PUT') { const b = JSON.parse(o.body); window.__chiefWrites.push(b); Object.assign(window.__chiefValues,b); return json({ok:true}); } return json({settings:window.__chiefValues}); }
                    if (p === '/api/sessions/live' || p === '/api/board/projects') return json([]); return real(u,o); }; return true; })()`);
            await ev(`window.showSettingsModal('chief')`);
            await waitFor(`document.getElementById('settings-chief-host').dataset.ready === '1'`, 'Chief ready');
            await ev(`document.querySelector('#settings-chief-host [name=chief_actions]').scrollIntoView({block:'center'}); true`);
            await pick('act'); await ev(framesJs(5)); await shot(`chief-act-${width}`);
            if (!(await confirmOpen())) { failures.push(`${width}: Act saved without confirmation`); continue; }
            assert.equal(await ev('window.__chiefWrites.length'), 0);
            assert.match(await ev(`document.getElementById('confirm-modal-message').textContent`), /edits without asking.*shell command still asks.*restarts/s);
            await ev(`document.querySelector('#confirm-modal .modal-actions .btn:not(#confirm-modal-yes)').click(); true`);
            assert.equal(await ev(`document.querySelector('#settings-chief-host [name=chief_actions]').value`), 'ask_first');
            assert.equal(await ev('window.__chiefWrites.length'), 0);
            await pick('act'); assert.equal(await confirmOpen(), true);
            await ev(`document.getElementById('confirm-modal-yes').click(); true`);
            await waitFor(`window.__chiefValues.chief_actions === 'act'`, 'confirmed Act saved');
            assert.deepEqual(await ev('window.__chiefWrites'), [{ chief_actions: 'act' }]);
            await pick('act'); await ev(framesJs(3)); assert.equal(await confirmOpen(), false);
            assert.equal(await ev('window.__chiefWrites.length'), 1);
            await pick('ask_first'); await waitFor(`window.__chiefValues.chief_actions === 'ask_first'`, 'Ask first saved without confirm');
            assert.equal(await confirmOpen(), false);
            assert.equal(await ev('window.__chiefWrites.length'), 2);
        }
        assert.deepEqual(failures, []); console.log('PASS Chief Act confirmation, Cancel, no duplicate prompt, leaving Act');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
