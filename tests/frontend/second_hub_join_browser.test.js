// Add computer, the second-Hub join (#21221, the approved second_hub_join_ui_mock): over SSH first, then asking at a level, waiting for Allow, the 8-digit code, linked; with a key; the ways it ends.
// 1280 and 390, dark and light. The routes are faked here (their own tests are Go's, #21220); this checks what the page asks for and says. SHOT_DIR=<dir> saves screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const { coralReady } = require('./helpers/wait');

const SERVERS = [{ id: 'local', label: 'studio-mac', local: true, status: 'online' }, { id: 'epoch', label: 'epoch', url: 'https://epoch.example.net:8420', status: 'online' }];

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const ok = name => console.log(`   ✓ ${name}`);
    const shot = async n => { if (process.env.SHOT_DIR) fs.writeFileSync(`${process.env.SHOT_DIR}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.__calls = []; window.__state = { state: 'pending' }; window.__codeStatus = 403; window.__joinStatus = 200;
            window.fetch = (u, o = {}) => { const p = new URL(String(u), location.origin).pathname; const m = (o.method || 'GET').toUpperCase();
                const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
                if (p === '/api/health') return json(200, { status: 'ok', hub: true, version: '2.1.13' });
                if (p === '/api/servers' && m === 'GET') return json(200, [].concat(${JSON.stringify(SERVERS)}, window.__added || []));
                if (p === '/api/servers/join' && m === 'POST') { window.__calls.push({ p, body: JSON.parse(o.body) }); return window.__joinStatus === 200 ? json(200, { join: 'j1', state: 'pending' }) : json(window.__joinStatus, { error: 'Could not make a request key on that computer over SSH: connection refused' }); }
                if (p === '/api/servers/join/j1' && m === 'GET') return json(200, window.__state);
                if (p === '/api/servers/join/j1/code' && m === 'POST') { const b = JSON.parse(o.body); window.__calls.push({ p, body: b }); if (window.__codeStatus === 201) { window.__added = [{ id: 'studio', label: 'Studio', url: 'https://studio.example.com', status: 'unknown' }]; return json(201, { id: 'studio', label: 'Studio', cap: 'view' }); } return json(window.__codeStatus, { error: 'wrong code' }); }
                return R(u, o); }; })();` });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `at ${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            for (const theme of ['dark', 'light']) {
                await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                await ev(`(async () => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); s.state.hub = true; s.state.servers = ${JSON.stringify(SERVERS)}; window.switchNavTab('servers'); return true; })()`);
                await setTheme(ev, theme);
                await waitFor(`!!document.querySelector('[data-action=add]')`, 'Add computer');
                await ev(`document.querySelector('[data-action=add]').click(); true`);
                await waitFor(`!!document.querySelector('.shj-form')`, `${at}the join form`);
                const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
                const sideways = async what => assert.ok(!(await ev(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`)), `${at}${theme}: ${what} does not scroll the page sideways`);

                // 1. over SSH is first and chosen; the URL and key form is behind Advanced
                assert.equal(await ev(`document.querySelector('.shj-ways input:checked').value`), 'ssh', at + 'Over SSH is the default');
                assert.equal(await ev(`document.querySelector('.servers-advanced').open`), false, at + 'the URL and key form is behind Advanced');
                assert.match(await text('.servers-advanced summary'), /Advanced: add by URL and key/);
                assert.deepEqual(await ev(`[...document.querySelectorAll('.shj-levels input')].map(i => i.value + ':' + i.checked)`), ['view:false', 'interact:true', 'launch:false'], at + 'the three levels to ask for');
                await sideways('the SSH form'); await shot(`join_1_ssh_${w}_${theme}`);
                ok(`${at}${theme}: Over SSH first, three levels, the old form behind Advanced`);

                // 2. nothing typed: said, not sent
                await ev(`document.querySelector('.shj-form button[type=submit]').click(); true`);
                assert.match(await text('.shj-error'), /Enter the SSH address/);
                assert.equal(await ev(`window.__calls.length`), 0, at + 'nothing was sent');

                // 3. SSH unreachable: the reason the Hub got, on the same panel, the fields kept
                await ev(`window.__joinStatus = 502; document.querySelector('.shj-form input[type=text]').value = 'me@studio.example.com'; [...document.querySelectorAll('.shj-form input[type=url]')][0].value = 'https://studio.example.com'; document.querySelector('.shj-form button[type=submit]').click(); true`);
                await waitFor(`/connection refused/.test((document.querySelector('.shj-error') || {}).textContent || '')`, `${at}the SSH failure said`);
                assert.equal(await ev(`document.querySelector('.shj-form input[type=text]').value`), 'me@studio.example.com', at + 'the address is kept');
                await shot(`join_6_ssh_failed_${w}_${theme}`);

                // 4. ask: the body names the computer, the address, the level and the SSH target
                await ev(`window.__joinStatus = 200; window.__calls.length = 0; document.querySelector('.shj-levels input[value=interact]').click(); document.querySelector('.shj-form input[id$=label]').value = 'Studio'; document.querySelector('.shj-form button[type=submit]').click(); true`);
                await waitFor(`!!document.querySelector('.shj-steps')`, `${at}the waiting step`);
                assert.deepEqual(await ev(`window.__calls[0].body`), { id: 'studio', label: 'Studio', url: 'https://studio.example.com', cap: 'interact', ssh_target: 'me@studio.example.com' }, at + 'what was asked');
                assert.match(await text('.shj-status'), /Waiting for Allow on the Coral/);
                assert.match(await text('.shj-body'), /Inbox/); assert.match(await text('.shj-pills'), /Asked for: Interact/);
                await sideways('the waiting step'); await shot(`join_3_waiting_${w}_${theme}`);
                ok(`${at}${theme}: asks at the chosen level and waits for Allow`);

                // 5. allowed at a lower level: said before the code; the code field groups 4-4 and takes digits only
                await ev(`window.__state = { state: 'allowed', cap: 'view' }; true`);
                await waitFor(`!!document.querySelector('.shj-code')`, `${at}the code step`, 9000);
                assert.match(await text('.shj-status'), /You asked for Interact; it allowed View/);
                await ev(`(() => { const c = document.querySelector('.shj-code'); c.value = '48a2-17 390 99'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
                assert.equal(await ev(`document.querySelector('.shj-code').value`), '4821 7390', at + 'grouped 4-4, digits only');
                await sideways('the code step'); await shot(`join_4_code_${w}_${theme}`);

                // 6. a wrong code: the tries left, the field kept; the right one links
                await ev(`document.querySelector('.shj-foot .btn-primary').click(); true`);
                await waitFor(`/4 tries left/.test(document.body.innerText)`, `${at}the tries left`);
                assert.match(await text('.shj-status.shj-bad'), /That code is not right/);
                await ev(`window.__codeStatus = 201; document.querySelector('.shj-code').value = '4821 7390'; document.querySelector('.shj-foot .btn-primary').click(); true`);
                await waitFor(`/is linked/.test(document.body.innerText)`, `${at}linked`);
                assert.deepEqual(await ev(`window.__calls.filter(c => c.p.endsWith('/code')).map(c => c.body.code)`), ['48217390', '48217390'], at + 'the code is sent as digits');
                assert.match(await text('.shj-status'), /Studio is linked[\s\S]*Access: View \(allowed on the Coral\)/);
                assert.match(await text('.shj-lead'), /coral cloud links/);
                await sideways('the linked step'); await shot(`join_5_linked_${w}_${theme}`);
                await ev(`document.querySelector('.shj-foot .btn-primary').click(); true`);
                await waitFor(`!document.querySelector('.shj-form, .shj-body') && !!document.querySelector('#server-row-studio')`, `${at}Done returns to the list with the new computer`);
                ok(`${at}${theme}: lower level said, wrong code counted, linked with its level, Done returns to the list`);
                await ev(`window.__added = null; window.__codeStatus = 403; window.__state = { state: 'pending' }; true`);

                // 7. with a key: the key field is write-only and leaves the page when sent; denied offers Ask again
                await ev(`document.querySelector('[data-action=add]').click(); true`);
                await waitFor(`!!document.querySelector('.shj-form')`, `${at}the form again`);
                await ev(`document.querySelector('.shj-ways input[value=key]').click(); true`);
                await waitFor(`!!document.querySelector('.shj-form input[type=password]')`, `${at}the key field`);
                await ev(`window.__calls.length = 0; document.querySelector('.shj-form input[type=url]').value = 'https://box.example.com:8420'; document.querySelector('.shj-form input[type=password]').value = 'lrk_aaaaaaaa_' + '0'.repeat(32); document.querySelector('.shj-levels input[value=launch]').click(); document.querySelector('.shj-form button[type=submit]').click(); true`);
                await waitFor(`!!document.querySelector('.shj-steps')`, `${at}waiting with a key`);
                const b = await ev(`window.__calls[0].body`);
                assert.equal(b.cap, 'launch'); assert.equal(b.url, 'https://box.example.com:8420'); assert.match(b.key, /^lrk_/); assert.equal(b.ssh_target, undefined);
                assert.equal(await ev(`document.documentElement.outerHTML.includes('lrk_aaaaaaaa')`), false, at + 'the key is not left in the page');
                await ev(`window.__state = { state: 'denied' }; true`);
                await waitFor(`/Denied on the Coral/.test(document.body.innerText)`, `${at}denied`, 9000);
                assert.match(await text('.shj-status.shj-bad'), /Nothing was linked/);
                await shot(`join_7_denied_${w}_${theme}`);
                await ev(`[...document.querySelectorAll('.shj-foot .btn')].find(x => x.textContent === 'Ask again').click(); true`);
                await waitFor(`!!document.querySelector('.shj-form')`, `${at}Ask again returns to the form`);
                ok(`${at}${theme}: with a key; the key leaves the page; denied has its words and Ask again`);
            }
        }
        console.log('PASS second hub join');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; process.exit(1); });
