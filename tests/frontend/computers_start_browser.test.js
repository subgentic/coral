// #20388 (mock #20111): every computer on the Computers page has New agent, New team and New terminal. A computer that cannot start one says why in words (Hub access View, with the way to change it;
// offline); the others open the launch flow on that computer. The stubbed two-computer Hub (helpers/hub_world), at 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(400); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const click = async sel => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`); if (!r) return false; await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 }); return true; };
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false });
        for (const [w, mobile] of [[1280, false], [390, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab==='function' && !!window.__coralReady`, 'dashboard'); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`document.querySelectorAll('#servers-tab-body tr.cs-row').length >= 2`, 'computers', 10000);
            const rows = await ev(`[...document.querySelectorAll('#servers-tab-body tr.cs-row')].map(tr => ({ name: tr.querySelector('.cs-name')?.textContent, buttons: [...tr.querySelectorAll('.computer-start-btn')].map(b => ({ text: b.textContent, kind: b.dataset.computerStart, disabled: b.disabled, h: Math.round(b.getBoundingClientRect().height) })), note: tr.querySelector('.computer-start-note')?.textContent || '' }))`);
            const by = n => rows.find(r => r.name === n) || { buttons: [], note: '' };
            check(`${tag}: each computer has New agent, New team, New terminal in that order`, rows.length >= 2 && rows.every(r => JSON.stringify(r.buttons.map(b => b.text)) === JSON.stringify(['New agent', 'New team', 'New terminal'])), JSON.stringify(rows.map(r => r.buttons.map(b => b.text))));
            check(`${tag}: a computer with Interact access has the three starts on`, by('Desktop').buttons.length === 3 && by('Desktop').buttons.every(b => !b.disabled) && by('Desktop').note === '', JSON.stringify(by('Desktop')));
            check(`${tag}: a computer with View access has them off and says why, with the way to change it`, by('Laptop').buttons.every(b => b.disabled) && /Hub access is View, so it cannot start things\./.test(by('Laptop').note) && /Change to Interact/.test(by('Laptop').note), JSON.stringify(by('Laptop')));
            if (mobile) { const shown = await ev(`['agents', 'seen', 'access'].map(k => { const td = document.querySelector('#servers-tab-body tr.cs-row td[data-key="' + k + '"]'); return !td || getComputedStyle(td).display !== 'none'; })`); check(`${tag}: the card shows name and status, not Agents, Last seen or Hub access (they are on the page)`, shown.every(v => v === false), JSON.stringify(shown)); }
            if (mobile) check(`${tag}: on a phone the starts are 44 px tall`, by('Desktop').buttons.every(b => b.h >= 44), JSON.stringify(by('Desktop').buttons.map(b => b.h)));
            await shot(`after-computers-${w}`);
            for (const kind of ['agent', 'team', 'terminal']) {
                const sel = `#servers-tab-body tr.cs-row[data-id="m2"] .computer-start-btn[data-computer-start="${kind}"]`;
                const clicked = await click(sel);
                await waitFor(`(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, `the launch flow opens for ${kind}`, 5000);
                const st = await ev(`(() => { const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; }; return { agent: shown('launch-step-agent'), team: shown('launch-step-team'), terminal: shown('launch-step-terminal'), onPage: !!document.querySelector('#servers-tab-body') }; })()`);
                check(`${tag}: New ${kind} on Desktop opens its own step`, clicked && st[kind] === true, JSON.stringify(st));
                await ev(`window.hideLaunchModal?.(); true`);
            }
            const disabledClick = await click(`#servers-tab-body tr.cs-row[data-id="m1"] .computer-start-btn[data-computer-start="agent"]`);
            await sleep(300); // sleep-ok: a refused click must stay refused
            check(`${tag}: a click on an off start opens nothing`, disabledClick && !(await ev(`(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`)));
            // an off New agent stays the primary button, dimmed (mock #20111); the other off buttons go flat
            const look = await ev(`(() => { const bg = k => getComputedStyle(document.querySelector('#servers-tab-body tr.cs-row[data-id="m1"] .computer-start-btn[data-computer-start="' + k + '"]')).backgroundColor; return { agent: bg('agent'), team: bg('team') }; })()`);
            check(`${tag}: an off New agent is still the dimmed blue button, the others are flat`, look.agent !== 'rgba(0, 0, 0, 0)' && look.team === 'rgba(0, 0, 0, 0)', JSON.stringify(look));
            // the computer's own page carries the same starts, by Rename and More
            await ev(`document.querySelector('#servers-tab-body tr.cs-row[data-id="m2"] .cs-open').click(); true`);
            await waitFor(`!!document.querySelector('#servers-tab-body .cs-page')`, 'the computer page', 5000);
            const pageStarts = await ev(`[...document.querySelectorAll('#servers-tab-body .cs-page .computer-start-btn')].map(b => b.textContent)`);
            check(`${tag}: the computer's page has New agent, New team, New terminal`, JSON.stringify(pageStarts) === JSON.stringify(['New agent', 'New team', 'New terminal']), JSON.stringify(pageStarts));
            await ev(`document.getElementById('servers-back').click(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Computers start checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
