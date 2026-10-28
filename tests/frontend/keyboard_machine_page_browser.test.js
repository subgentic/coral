// The Hub's machine page by keyboard alone (#9783, the v2.0.2 keyboard pass): a row is one Open button; Enter opens the machine's page and puts focus on it; Back is the page's first stop and Enter on it returns to the list with focus on that machine's row;
// Rename opens its field with focus in it; More opens the Revoke confirmation and Escape cancels it with focus back on More; every control's name is the one Chrome computes (axName). The stubbed two-computer Hub of the keyboard census, at 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const kb = require('./helpers/keyboard_census');
const { axName } = require('./helpers/ax_tree');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const found = [];
    const check = (ok, msg) => { if (!ok) found.push(msg); };
    const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], Escape: [27, 'Escape'] };
    const key = async k => { const [code, name] = KEYS[k]; const text = k === 'Enter' ? '\r' : undefined; await client.Input.dispatchKeyEvent({ type: text ? 'keyDown' : 'rawKeyDown', key: k, code: name, windowsVirtualKeyCode: code, text }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code: name, windowsVirtualKeyCode: code }); await new Promise(r => setTimeout(r, 60)); }; // sleep-ok: the key's handlers run
    void kb;
    const active = () => ev(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, id: e.id || '', cls: String(e.className || ''), text: (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) } : null; })()`);
    const mark = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)}).setAttribute('data-axp', 'x'); true`); return axName(client, '[data-axp="x"]'); };
    const tabTo = async (re, max = 25) => { for (let i = 0; i < max; i++) { await key('Tab'); const a = await active(); if (a && re.test(a.text)) return a; } return null; };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: keyboard focus and re-render settle
    try {
        await setupHubWorld({ client, Page, Emulation, width: 1280, height: 800, mobile: false });
        for (const [tag, w, mobile] of [['1280', 1280, false], ['390', 390, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: mobile ? 844 : 800, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab==='function' && !!window.__coralReady`, 'dashboard'); await ev(`window.__coralReady.startup('liveList','settings')`);
            await ev(`window.switchNavTab('servers'); true`);
            await waitFor(`document.querySelectorAll('#servers-tab-body .cs-open').length >= 2`, `${tag}: the machines`, 10000);
            const rowName = await mark('#servers-tab-body .cs-open'); check(rowName && /^Open (Laptop|Desktop), (online|offline)/.test(rowName.name), `${tag}: the row button's name is "Open <name>, <state>": ${JSON.stringify(rowName)}`);
            await ev(`document.querySelector('#servers-tab-body .cs-open').focus(); true`); await key('Enter'); await settle(300);
            await waitFor(`!!document.querySelector('#servers-tab-body section.cs-page')`, `${tag}: Enter opens the page`);
            let a = await active(); check(a && /cs-page/.test(a.cls), `${tag}: focus is on the page after Enter: ${JSON.stringify(a)}`);
            const bk = await mark('#servers-back'); check(bk && /Servers/.test(bk.name) && bk.role === 'button', `${tag}: Back is a button named Servers: ${JSON.stringify(bk)}`);
            await key('Tab'); a = await active(); check(a && a.id === 'servers-back', `${tag}: Back is the page's first Tab stop: ${JSON.stringify(a)}`);
            await key('Enter'); await settle(300);
            a = await active(); check(a && /cs-open/.test(a.cls) && /^Open (Laptop|Desktop)/.test(a.text), `${tag}: Back puts focus on the machine's row button: ${JSON.stringify(a)}`);
            check(await ev(`!document.querySelector('#servers-tab-body section.cs-page')`), `${tag}: Back shows the list`);
            // Rename
            await key('Enter'); await settle(300);
            const rn = await tabTo(/^Rename/); check(!!rn, `${tag}: Tab reaches Rename on the page`);
            if (rn) { await key('Enter'); await settle(300); a = await active(); check(a && a.tag === 'INPUT', `${tag}: Rename puts focus in its field: ${JSON.stringify(a)}`); await key('Escape'); await settle(300); a = await active(); check(!(await ev(`!!document.querySelector('#servers-tab-body .cs-rename input')`)), `${tag}: Escape closes the rename field (focus: ${JSON.stringify(a)})`); check(a && /Rename/.test(a.text), `${tag}: and focus returns to Rename: ${JSON.stringify(a)}`); }
            // More, Revoke, Escape
            const more = await tabTo(/^More/); check(!!more, `${tag}: Tab reaches More`);
            if (more) { await key('Enter'); await settle(300); const rv = await tabTo(/^Revoke/, 6); check(!!rv, `${tag}: Tab reaches Revoke after More opens it`);
                if (rv) { await key('Enter'); await settle(300); const conf = await ev(`!!document.querySelector('#servers-tab-body .cs-revoke-cancel')`); check(conf, `${tag}: Revoke asks to confirm`); await key('Escape'); await settle(300); a = await active(); check(!(await ev(`!!document.querySelector('#servers-tab-body .cs-revoke-cancel')`)), `${tag}: Escape cancels the confirmation (focus: ${JSON.stringify(a)})`); check(a && /^(Revoke|More)/.test(a.text), `${tag}: and focus is on Revoke or More, not lost: ${JSON.stringify(a)}`); } }
            console.log(`   ${tag}: done`);
        }
    } finally { await client.close(); }
    assert.deepEqual(found, [], 'the machine page by keyboard:\n  ' + found.join('\n  '));
    console.log('PASS the machine page by keyboard');
})().catch(e => { console.error(e); process.exit(1); });
