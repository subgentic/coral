// The Computers page says what it shows (#12878, coral-hub's beta pass on a real account): (1) a real click on a computer's NAME opens that computer's page; (2) the Hub access choices are explained where they are made: each
// option carries its line and the chosen one's line is shown under the select; (3) the dot beside the name is the computer's health, and when it is not fine the words say so beside "Online" (not only in the dot's tooltip).
// The stubbed two-computer Hub (helpers/hub_world), at 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(400); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const click = async sel => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`); if (!r) return false; await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }); return true; };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab==='function' && !!window.__coralReady`, 'dashboard'); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.__computers[0].machine_health = { status: 'busy', reason: 'cpu', busy_by: 'coral' }; window.switchNavTab('servers'); true`);
            await waitFor(`document.querySelectorAll('#servers-tab-body .cs-open').length >= 2`, 'machines', 10000);
            await shot(`after-list-${w}`);
            const rows = await ev(`[...document.querySelectorAll('#servers-tab-body tr.cs-row')].map(tr => ({ name: tr.querySelector('.cs-name')?.textContent, status: (tr.querySelector('.cs-col-status')?.textContent || '').replace(/\\s+/g, ' ').replace(/^Status/, '').trim(), line: tr.querySelector('.cs-access-line')?.textContent || '', opts: [...tr.querySelectorAll('.cs-launch option')].map(o => [o.value, o.title]), described: tr.querySelector('.cs-launch select')?.getAttribute('aria-describedby') || '' }))`);
            const by = n => rows.find(r => r.name === n) || {};
            check(`${tag}: the busy computer's Status says so in words beside Online`, by('Laptop').status === 'Online, Busy (CPU)', JSON.stringify(by('Laptop').status));
            check(`${tag}: a computer with no health reading says only Online`, by('Desktop').status === 'Online', JSON.stringify(by('Desktop').status));
            check(`${tag}: each Hub access choice carries its line`, ['Laptop', 'Desktop'].every(n => by(n).opts.length === 3 && by(n).opts.every(([v, t]) => t.length > 20) && new Set(by(n).opts.map(o => o[1])).size === 3), JSON.stringify(by('Laptop').opts));
            check(`${tag}: the chosen access's line is shown under the select (View, Interact)`, /^Look at terminals, chats, files and boards\. Changes nothing\.$/.test(by('Laptop').line) && /^Also type into running agents and post on boards\.$/.test(by('Desktop').line), JSON.stringify([by('Laptop').line, by('Desktop').line]));
            check(`${tag}: the select is described by that line`, / [^ ]+-line$/.test(by('Laptop').described), by('Laptop').described);
            const clicked = await click('#servers-tab-body .cs-name');
            await sleep(500); // sleep-ok: the page draws
            check(`${tag}: a real click on the computer's name opens its page`, clicked && (await ev(`!!document.querySelector('#servers-tab-body .cs-page-name')`)), String(clicked));
            await shot(`after-page-${w}`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Computers page checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
