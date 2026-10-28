// A folder opened by the person in the Inbox on a phone does not raise the screen keyboard (Mobile tester's first pass, #9985): the page's search box took the focus (the desktop's rule, #7404), and a focused text field is a keyboard
// on a phone. At 390 the focus is on the first row or the heading, never a text field; at 1280 it is still the search box. Drives Chrome over CDP through agent_view_harness.js on the isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 800, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Emulation.setEmulatedMedia({ features: mobile ? [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] : [] });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            for (const folder of ['tasks', 'goals']) {
                await waitFor(`!!document.querySelector('.view-list-item[data-key="${folder}"]')`, `${w}: the ${folder} folder in the list`, 10000);
                await ev(`(() => { const all = [...document.querySelectorAll('.view-list-item[data-key="${folder}"]')]; (all.find(b => b.getClientRects().length > 0) || all[0]).click(); return true; })()`); // a tap on the folder (the phone's list is behind its picker: the same item, the same pick)
                await waitFor(`document.getElementById('group-table-view') && document.getElementById('group-table-view').dataset.group === 'hub-inbox:${folder}' && !!document.querySelector('#group-table-view .list-bar-search, #group-table-view .gt-search')`, `${w}: the ${folder} page with its search box`, 10000);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the focus moves after the table is drawn
                const a = await ev(`(() => { const e = document.activeElement; return e ? { tag: e.tagName, search: !!(e.classList && (e.classList.contains('list-bar-search') || e.classList.contains('gt-search'))), type: e.type || '' } : null; })()`);
                const text = !!a && (a.tag === 'INPUT' || a.tag === 'TEXTAREA' || a.tag === 'SELECT');
                if (mobile && text) problems.push(`${w}: opening ${folder} raises the keyboard (focus is on a ${a.tag} ${a.type}), it starts at the first row or the heading`);
                if (!mobile && !(a && a.search)) problems.push(`${w}: opening ${folder} no longer puts the keyboard on the search box: ${JSON.stringify(a)}`);
            }
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the Inbox folder on a phone:\n  ' + problems.join('\n  '));
    console.log('PASS the Inbox folder on a phone does not raise the keyboard');
})().catch(e => { console.error(e); process.exit(1); });
