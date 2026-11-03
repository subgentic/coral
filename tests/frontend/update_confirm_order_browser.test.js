// The update confirmation's footer reads the same in every order a person meets it in (#12936, UI Reviewer's ruling on #12791/#12897, R1): Later first, the primary (Update and relaunch, or Install update on
// Windows) last. On a phone the two stack, Later ABOVE the primary, with no column-reverse, so the DOM, the reading, the Tab order and what is drawn agree. Later still has the first focus when agents would restart.
// At 1280 px (side by side), 390 px, 390 px at 200% text, and a coarse landscape phone (844x390), for the macOS and Linux relaunch and for the Windows install; no update is ever installed. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { DATA_WORLD, UPDATE_STAGED } = require('./helpers/census_world');
const { showUpdateReady, UPDATE_DIALOG_UP } = require('./helpers/phone_targets');
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const key = async (k, code, vk) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    let version = 160;
    const staged = win => {
        const s = JSON.parse(JSON.stringify(UPDATE_STAGED)); s.staged.version = `1.4.${++version}`;
        if (win) { s.local_install = true; s.install_kind = 'msi'; s.relaunch = { ...s.relaunch, available: false, reason: 'local_approval_needed' }; }
        return s;
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: DATA_WORLD });
        for (const view of [{ tag: '1280px', w: 1280, h: 800, phone: false, stacked: false }, { tag: '390px', w: 390, h: 844, phone: true, stacked: true },
            { tag: '390px at 200% text', w: 390, h: 844, phone: true, stacked: true, big: true }, { tag: 'coarse landscape 844x390', w: 844, h: 390, phone: true, stacked: true }]) {
            await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone }); await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await ev(`localStorage.clear(); true`);
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.switchNavTab('agents'); true`);
            if (view.big) await ev(`document.documentElement.style.fontSize = '32px'; true`);
            for (const win of [false, true]) {
                const tag = `${view.tag}, ${win ? 'Windows install' : 'relaunch'}`;
                await showUpdateReady(ev, waitFor, staged(win));
                await ev(`document.querySelector('.update-ready-review').click(); true`);
                await waitFor(UPDATE_DIALOG_UP, `${tag}: the confirmation`, 5000);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: focus settles as the dialog opens
                const d = await ev(`(() => { const f = document.querySelector('#update-confirm-modal .modal-actions'); const bs = [...f.querySelectorAll('button')]; const r = bs.map(b => b.getBoundingClientRect());
                    return { names: bs.map(b => b.textContent.trim()), dir: getComputedStyle(f).flexDirection, laterTop: r[0].top, goTop: r[1].top, laterLeft: r[0].left, goLeft: r[1].left, laterBottom: r[0].bottom, laterH: r[0].height, goH: r[1].height,
                        primaryLast: bs[bs.length - 1].classList.contains('btn-primary') && !bs[0].classList.contains('btn-primary'), focus: document.activeElement.textContent.trim() }; })()`);
                check(`${tag}: Later first in the DOM, the primary last (${JSON.stringify(d.names)})`, d.names.length === 2 && d.names[0] === 'Later' && /^(Update and relaunch|Install update|Relaunch)/i.test(d.names[1]) && d.primaryLast);
                if (view.stacked) check(`${tag}: stacked, Later ABOVE the primary, and the footer is a plain column (${d.dir}; later ${Math.round(d.laterTop)}, primary ${Math.round(d.goTop)})`, d.dir === 'column' && d.laterTop < d.goTop && d.laterBottom <= d.goTop + 1);
                else check(`${tag}: side by side, Later on the left (${d.dir}; later ${Math.round(d.laterLeft)}, primary ${Math.round(d.goLeft)})`, d.dir === 'row' && d.laterLeft < d.goLeft && Math.abs(d.laterTop - d.goTop) < 4);
                check(`${tag}: both are at least 44 px tall on a phone`, !view.phone || (d.laterH >= 43.5 && d.goH >= 43.5), `${d.laterH} and ${d.goH}`);
                check(`${tag}: Later has the first focus when agents would restart (${d.focus})`, d.focus === 'Later');
                await key('Tab', 'Tab', 9);
                const next = await ev(`document.activeElement.textContent.trim()`);
                check(`${tag}: Tab goes from Later to the primary, the order drawn (${next})`, /^(Update and relaunch|Install update|Relaunch)/i.test(next));
                await key('Escape', 'Escape', 27);
                await waitFor(`!(${UPDATE_DIALOG_UP})`, `${tag}: the dialog closed`, 5000);
            }
        }
    } finally { await client.close(); }
    if (results.some(r => !r)) { console.error(`${results.filter(r => !r).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} update confirmation order checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
