// #14822: through the Hub the job and workflow lists are not read (#14820), so the Automations page must not say none exist: it says 'Automations run on each computer.' with a way to open a computer (the Computers dialog).
// A wide screen and a phone, through the stubbed Hub world (helpers/hub_world.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const { setupHubWorld } = require('./helpers/hub_world');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const check = (label, ok, detail) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await setupHubWorld({ client, Page, Emulation, width: w, height: h, mobile, inbox: 'native', needs: true, hubPages: true });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`window.switchNavTab('automations'); true`);
            await waitFor(`/Automations run on each computer/.test(document.body.innerText)`, `${at}the Hub line`, 10000).catch(async e => { throw new Error(e.message + ' ' + (await ev(`JSON.stringify({ tabs: [...document.querySelectorAll('[data-arg=automations]')].map(e => [e.id, e.hidden, e.getClientRects().length]), cls: document.body.className, view: [...document.querySelectorAll('.view.active, [id$=-view]:not([hidden])')].map(e => e.id).slice(0, 6), txt: document.body.innerText.slice(0, 300) })`))); });
            await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page settles
            const text = await ev(`document.getElementById('group-table-view') ? document.getElementById('group-table-view').innerText : document.body.innerText`);
            await shot(`hub-automations-${w}`);
            check(`${at}it says automations run on each computer`, /Automations run on each computer\./.test(text), JSON.stringify(text.slice(0, 200)));
            check(`${at}it does not say none exist ('No jobs yet', 'New job schedules one')`, !/No jobs yet|No workflows yet|New job schedules one/.test(text), JSON.stringify(text.slice(0, 200)));
            const open = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Open a computer/.test(x.textContent) && x.getClientRects().length > 0); if (!b) return false; b.click(); return true; })()`);
            check(`${at}there is an 'Open a computer' control`, open === true);
            await waitFor(`/Computers/.test((document.querySelector('.top-nav-tabs .active, #nav-tab-servers.active, [role=tab][aria-selected=true]') || {}).textContent || '') || !!document.querySelector('#servers-view:not([hidden]), #servers-tab-content:not([hidden])')`, `${at}the Computers page opens`, 8000).then(() => check(`${at}Open a computer goes to Computers`, true), async () => check(`${at}Open a computer goes to Computers`, false, await ev(`JSON.stringify({ active: [...document.querySelectorAll('.active, [aria-selected=true]')].map(e => e.id || e.textContent.trim().slice(0, 20)).slice(0, 8) })`)));
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
