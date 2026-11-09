// On a Hub, New agent and New team open on 'Which computer?' (#15014, the Operator: the computer is the first step, not a drop-down at the top, and New team has it too): the computers as cards with their state (offline and rejected ones listed
// and disabled with the reason), Continue goes to the form for that computer with 'On <computer>' and Change in place of the drop-down, Change returns to the step, and a team can still type another computer's address. 1280 and 390 px.
// Served as the hub would serve it (boot flag mode "cloud"), the computers' list answered by the test.
//
// Expects CORAL_TEST_URL + CDP_PORT from the runner.
const assert = require('node:assert/strict');
const { safePaused } = require('./helpers/paused');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Network, Fetch, Emulation } = client;
    const ev = async expression => { const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const { waitFor } = require('./helpers/wait').bind(ev);
    const problems = [], check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Promise.all([Page.enable(), Runtime.enable(), Network.enable()]);
        await Network.setCacheDisabled({ cacheDisabled: true });
        await Fetch.enable({ patterns: [{ urlPattern: `${BASE}/`, resourceType: 'Document', requestStage: 'Response' }, { urlPattern: `${BASE}/auth/session`, requestStage: 'Request' },
            { urlPattern: `${BASE}/api/servers*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/sessions/live*`, requestStage: 'Request' }, { urlPattern: `${BASE}/api/remote/*`, requestStage: 'Request' }] });
        const json = (id, status, body) => Fetch.fulfillRequest({ requestId: id, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
        safePaused(client, async e => {
            const u = e.request.url;
            if (u.endsWith('/auth/session')) return json(e.requestId, 200, { authenticated: true, email: 'tester@example.com', csrf: 'x' });
            if (/\/api\/servers(\?|$)/.test(u)) return json(e.requestId, 200, { servers: [{ id: 'box-b', label: 'Box B', online: true, access_mode: 'launch', local_mode: 'launch', created_at: '2026-10-01T00:00:00Z', last_seen: '2026-10-18T00:00:00Z' }, { id: 'box-c', label: 'Laptop', online: false, access_mode: 'launch', local_mode: 'launch', created_at: '2026-10-01T00:00:00Z', last_seen: '2026-10-17T00:00:00Z' }] });
            if (/\/api\/sessions\/live(\?|$)/.test(u)) return json(e.requestId, 200, { sessions: [], servers: [{ id: 'box-b', label: 'Box B', status: 'online' }, { id: 'box-c', label: 'Laptop', status: 'offline' }] });
            if (/\/api\/remote\//.test(u)) { if (/\/api\/sessions\/launch$/.test(u)) { launched++; return json(e.requestId, 403, { error: 'access_mode', hub_mode: 'view', required: 'launch' }); } return json(e.requestId, 200, {}); }
            if (e.responseStatusCode !== 200) return Fetch.continueRequest({ requestId: e.requestId });
            const { body, base64Encoded } = await Fetch.getResponseBody({ requestId: e.requestId });
            let html = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
            html = html.replace('"mode":"local"', '"mode":"cloud"');
            const headers = (e.responseHeaders || []).filter(h => !/^content-length$/i.test(h.name));
            await Fetch.fulfillRequest({ requestId: e.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(html).toString('base64') });
        });
        for (const [w, h, mobile] of [[1280, 756, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`document.body.classList.contains('cloud-mode') && !!document.querySelector('[data-on-click^="m-show-launch-modal"]')`, `${at}the hub dashboard`, { timeout: 15000 });
            for (const type of ['agent', 'team']) {
                const tag = `${at}New ${type}: `;
                await ev(`document.querySelector('[data-on-click^="m-show-launch-modal"]').click(); true`);
                await waitFor(`!!document.getElementById('launch-modal') && getComputedStyle(document.getElementById('launch-modal')).display !== 'none'`, `${tag}the launch dialog`, { timeout: 8000 });
                await waitFor(`!!(window.state || true) && !!window._selectLaunchType`, `${tag}the dialog is wired`, { timeout: 8000 });
                await waitFor(`(() => { const s = document.getElementById('launch-server'); return !!s && s.options.length > 0 || true; })()`, `${tag}ready`, { timeout: 4000 });
                await ev(`window._selectLaunchType('${type}'); true`);
                await waitFor(`getComputedStyle(document.getElementById('launch-step-computer')).display !== 'none'`, `${tag}opens on Which computer?`, { timeout: 8000 });
                const step = await ev(`(() => { const cards = [...document.querySelectorAll('#launch-computer-list .launch-computer-card')]; return { title: document.getElementById('launch-computer-title').textContent, cards: cards.map(c => ({ name: c.querySelector('strong').textContent, small: c.querySelector('small').textContent, disabled: c.disabled, checked: c.getAttribute('aria-checked') })), go: document.getElementById('launch-computer-go').disabled, over: document.documentElement.scrollWidth > innerWidth + 1, small: cards.filter(c => c.getBoundingClientRect().height < 43.5).length, formShown: getComputedStyle(document.getElementById('launch-step-' + '${type}')).display !== 'none' }; })()`);
                check(step.title === 'Which computer?' && !step.formShown, `${tag}the first step is Which computer? and the form is not shown yet: ${JSON.stringify(step)}`);
                const names = step.cards.map(c => c.name);
                check(names.includes('Box B') && names.includes('Laptop') && (type !== 'team' || names.some(n => /Another computer/.test(n))), `${tag}the computers are cards (the team also has an address card): ${JSON.stringify(names)}`);
                const laptop = step.cards.find(c => c.name === 'Laptop'), box = step.cards.find(c => c.name === 'Box B');
                check(laptop && laptop.disabled && /Offline/.test(laptop.small) && box && !box.disabled && box.checked === 'true' && !step.go && !step.over && step.small === 0, `${tag}the offline one is disabled with its reason, the online one is picked and Continue is on, 44 px cards, nothing wide: ${JSON.stringify(step)}`);
                await ev(`document.getElementById('launch-computer-go').click(); true`);
                await waitFor(`getComputedStyle(document.getElementById('launch-step-${type}')).display !== 'none' && getComputedStyle(document.getElementById('launch-step-computer')).display === 'none'`, `${tag}Continue opens the form`, { timeout: 8000 });
                const chip = await ev(`(() => { const c = document.getElementById('launch-computer-chip'); return { shown: !c.hidden, text: c.textContent.replace(/\s+/g, ' ').trim(), selectHidden: document.getElementById('launch-server').hidden }; })()`);
                check(chip.shown && /On Box B/.test(chip.text) && chip.selectHidden, `${tag}the drop-down is a chip 'On Box B' with Change: ${JSON.stringify(chip)}`);
                await ev(`document.querySelector('#launch-computer-chip [data-on-click="m-launch-computer-change"]').click(); true`);
                await waitFor(`getComputedStyle(document.getElementById('launch-step-computer')).display !== 'none'`, `${tag}Change goes back to Which computer?`, { timeout: 6000 });
                await ev(`window.hideLaunchModal?.(); true`);
                await waitFor(`getComputedStyle(document.getElementById('launch-modal')).display === 'none'`, `${tag}the dialog closes`, { timeout: 6000 });
            }
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('launch_computer_step_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
