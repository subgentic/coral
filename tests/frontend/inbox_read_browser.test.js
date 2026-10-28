// The Inbox's read marker (#9687): a task or chat changed after the browser first used the marker is unread (an accent dot named Unread, the name at 600, a read name 500, the snippet and time unchanged);
// opening it makes it read, and that survives a reload. Desktop and phone rows. Only opening marks (nothing on hover or scroll). The seeded `since` is long ago; the census world's tasks are newer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; await new Promise(r => setTimeout(r, 400)); /* sleep-ok: a screenshot waits out transitions */ fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = '#group-table-view';
    const KEY = 'coral.inbox.read.v1';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 820, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const load = async () => {
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
                await ev(INBOX_WORLD);
                await ev(`window.switchNavTab('hub-inbox'); true`);
                await ev(`import((window.__coralStatic||'/static/')+'inbox_tab.js').then(m => m.selectInboxTab('tasks')).then(() => true)`);
                await waitFor(`document.querySelectorAll('${T} tbody tr.dt-row').length === 3`, at + 'the three tasks', 10000);
            };
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({ since: Date.now() - 90 * 86400000, items: {} })); true`); // first use was long ago: the tasks changed since are unread
            await load();
            const rows = () => ev(`[...document.querySelectorAll('${T} tbody tr.dt-row')].map(tr => { const name = tr.querySelector('.dt-mail-title') || tr.querySelector('button.dt-primary'); const cs = getComputedStyle(name); return { unread: tr.classList.contains('dt-unread') || !!tr.querySelector('.dt-mail-new'), weight: cs.fontWeight, sr: [...tr.querySelectorAll('.sr-only')].map(e => e.textContent).join(), dot: !!tr.querySelector('.dt-mail-new'), label: (tr.querySelector('button.dt-primary') || {}).getAttribute && tr.querySelector('button.dt-primary').getAttribute('aria-label') }; })`);
            let r = await rows();
            assert.ok(r.length === 3 && r.every(x => x.unread), at + 'every task changed since `since` is unread ' + JSON.stringify(r));
            if (mobile) assert.ok(r.every(x => x.dot && x.sr === 'Unread' && x.weight === '600' && /unread/.test(x.label || '')), at + 'phone: an accent dot named Unread, the name 600, the row\'s name says unread ' + JSON.stringify(r));
            else assert.ok(r.every(x => x.weight === '600'), at + 'desktop: the name is 600 ' + JSON.stringify(r));
            if (mobile) assert.equal(await ev(`(() => { const tr = document.querySelector('${T} tbody tr.dt-row'); const cs = e => getComputedStyle(tr.querySelector(e)); return [cs('.dt-mail-time').fontWeight, cs('.dt-mail-snippet').fontWeight].join(); })()`), '400,400', at + 'the time and the first words do not change with the read state');
            await shot(`inbox-read-unread-${w}`);
            // nothing marks on hover or scroll; opening does
            await ev(`document.querySelector('${T} tbody tr.dt-row').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); document.querySelector('${T}').scrollTop = 5; true`);
            assert.equal(await ev(`JSON.stringify(JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).items)`), '{}', at + 'hovering and scrolling mark nothing');
            await ev(`document.querySelector('${T} tbody tr.dt-row button.dt-primary').click(); true`);
            await waitFor(`document.getElementById('inbox-page').getClientRects().length > 0 && !!document.querySelector('#inbox-page .ibx-reply-input')`, at + 'the task opens', 10000);
            assert.equal(await ev(`Object.keys(JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})).items).length`), 1, at + 'opening stored one item');
            // back to the list (the world's stamps are made from the clock at each load, so a reload would move them: the store's persistence is pinned in inbox_read.test.mjs)
            await ev(`document.querySelector('#inbox-page .goals-back, #inbox-page .inbox-phone-back')?.click(); true`);
            await waitFor(`document.querySelectorAll('${T} tbody tr.dt-row').length === 3 && document.getElementById('inbox-page').hidden`, at + 'back to the list', 10000);
            r = await rows();
            assert.equal(r.filter(x => x.unread).length, 2, at + 'the opened task is read when the list is drawn again, the other two are still unread ' + JSON.stringify(r));
            assert.ok(r.some(x => !x.unread && x.weight === '400'), at + 'a read task title is 400, at a mouse and on a phone: a task is a row\'s own title, not a name, so it stays 13/400 and 600 is only the unread row (#9758, the operator\'s table-title rule; it was 500 on the phone) ' + JSON.stringify(r));
            await shot(`inbox-read-read-${w}`);
            console.log('PASS ' + at + 'the read marker');
        }
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
