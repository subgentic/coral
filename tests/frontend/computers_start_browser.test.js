// #20388 (mock #20111), changed by #20747 (the Operator: 'We don't need these buttons on this screen'): the Computers list has NO Start column and no New agent / New team / New terminal in any row. A computer's own page
// still carries the three starts (a computer that cannot start one says why in words: Hub access View, with the way to change it; offline), and the others open the launch flow on that computer. The stubbed two-computer Hub (helpers/hub_world), at 1280 and 390 px.
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
            const rows = await ev(`[...document.querySelectorAll('#servers-tab-body tr.cs-row')].map(tr => ({ name: tr.querySelector('.cs-name')?.textContent, buttons: [...tr.querySelectorAll('.computer-start-btn, [data-computer-start]')].length, note: tr.querySelector('.computer-start-note')?.textContent || '' }))`);
            check(`${tag}: no row has New agent, New team or New terminal, nor a reason under them`, rows.length >= 2 && rows.every(r => r.buttons === 0 && r.note === ''), JSON.stringify(rows));
            check(`${tag}: the list has no Start column`, await ev(`![...document.querySelectorAll('#servers-tab-body thead th')].some(h => h.dataset.key === 'start' || /^start$/i.test(h.textContent.trim()))`) && await ev(`!document.querySelector('#servers-tab-body td[data-key="start"]')`));
            if (mobile) { const shown = await ev(`['agents', 'seen', 'access'].map(k => { const td = document.querySelector('#servers-tab-body tr.cs-row td[data-key="' + k + '"]'); return !td || getComputedStyle(td).display !== 'none'; })`); check(`${tag}: the card shows name and status, not Agents, Last seen or Hub access (they are on the page)`, shown.every(v => v === false), JSON.stringify(shown)); }
            await shot(`after-computers-${w}`);
            // the computer's own page carries the three starts: Desktop (Interact) has them on, Laptop (View) has them off and says why
            const openPage = async id => { await ev(`document.querySelector('#servers-tab-body tr.cs-row[data-id="${id}"] .cs-open').click(); true`); await waitFor(`!!document.querySelector('#servers-tab-body .cs-page')`, 'the computer page', 5000); };
            const back = async () => { await ev(`document.getElementById('servers-back').click(); true`); await waitFor(`!document.querySelector('#servers-tab-body .cs-page')`, 'the list again', 5000); };
            await openPage('m2');
            const pg = await ev(`(() => { const p = document.querySelector('#servers-tab-body .cs-page'); return { buttons: [...p.querySelectorAll('.computer-start-btn')].map(b => ({ text: b.textContent, disabled: b.disabled, h: Math.round(b.getBoundingClientRect().height) })), note: p.querySelector('.computer-start-note')?.textContent || '' }; })()`);
            check(`${tag}: the computer's page has New agent, New team, New terminal, on, for a computer with Interact access`, JSON.stringify(pg.buttons.map(b => b.text)) === JSON.stringify(['New agent', 'New team', 'New terminal']) && pg.buttons.every(b => !b.disabled) && pg.note === '', JSON.stringify(pg));
            if (mobile) check(`${tag}: on a phone the page's starts are 44 px tall`, pg.buttons.every(b => b.h >= 44), JSON.stringify(pg.buttons.map(b => b.h)));
            await shot(`after-computer-page-${w}`);
            for (const kind of ['agent', 'team', 'terminal']) {
                const clicked = await click(`#servers-tab-body .cs-page .computer-start-btn[data-computer-start="${kind}"]`);
                await waitFor(`(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`, `the launch flow opens for ${kind}`, 5000);
                const st = await ev(`(() => { const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; }; return { agent: shown('launch-step-agent'), team: shown('launch-step-team'), terminal: shown('launch-step-terminal') }; })()`);
                check(`${tag}: New ${kind} on Desktop's page opens its own step`, clicked && st[kind] === true, JSON.stringify(st));
                await ev(`window.hideLaunchModal?.(); true`);
            }
            await back(); await openPage('m1');
            const off = await ev(`(() => { const p = document.querySelector('#servers-tab-body .cs-page'); return { buttons: [...p.querySelectorAll('.computer-start-btn')].map(b => b.disabled), note: p.querySelector('.computer-start-note')?.textContent || '' }; })()`);
            check(`${tag}: a computer with View access has them off on its page and says why, with the way to change it`, off.buttons.length === 3 && off.buttons.every(Boolean) && /Hub access is View, so it cannot start things\./.test(off.note) && /Change to Interact/.test(off.note), JSON.stringify(off));
            const disabledClick = await click(`#servers-tab-body .cs-page .computer-start-btn[data-computer-start="agent"]`);
            await sleep(300); // sleep-ok: a refused click must stay refused
            check(`${tag}: a click on an off start opens nothing`, disabledClick && !(await ev(`(() => { const m = document.getElementById('launch-modal'); return !!m && getComputedStyle(m).display !== 'none'; })()`)));
            const look = await ev(`(() => { const bg = k => getComputedStyle(document.querySelector('#servers-tab-body .cs-page .computer-start-btn[data-computer-start="' + k + '"]')).backgroundColor; return { agent: bg('agent'), team: bg('team') }; })()`);
            check(`${tag}: an off New agent is still the dimmed blue button, the others are flat`, look.agent !== 'rgba(0, 0, 0, 0)' && look.team === 'rgba(0, 0, 0, 0)', JSON.stringify(look));
            await ev(`document.getElementById('servers-back').click(); true`);
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} Computers start checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
