// A Hub page framed in the Hub-served Inbox (Needs you, Tasks, Saved for later: #9542) on a phone (#9660, UI/UX's 22:34 check): the folder button names the page, so no heading is drawn under it, and the frame runs
// edge to edge (no gutter, no panel fill); the heading stays in the page for a screen reader, clipped to 1 px. A desktop draws its heading and keeps its gutter. The stubbed two-computer Hub of helpers/hub_world.js (native boot); the frame's address is the Hub's page, which this test
// server does not serve: only the frame's place is tested. Shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { framesJs } = require('./helpers/wait');
const { setupHubWorld, BASE } = require('./helpers/hub_world');

const NAMES = { needs: 'Needs you', tasks: 'Tasks', saved: 'Saved' };

(async () => {
    const { client, Page, Emulation, ev, waitFor } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const shot = async name => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true }); await settle(300); fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async (w, h, mobile, group) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
        await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
        await coralReady('startup', 'liveList', 'settings');
        await ev(`window.switchNavTab('hub-inbox'); true`);
        await ev(`import((window.__coralStatic || '/static/') + 'inbox_tab.js').then(m => m.selectInboxTab(${JSON.stringify(group)})).then(() => true)`);
        await waitFor(`!!document.querySelector('#group-table-view iframe.inbox-frame')`, `the ${group} frame`, 10000);
    };
    const measurements = [];
    const probe = () => ev(`(() => { const v = document.getElementById('group-table-view'), f = v.querySelector('iframe.inbox-frame'), r = f.getBoundingClientRect(), cs = getComputedStyle(v); return { src: f.getAttribute('src'), heading: (document.getElementById('group-table-title') || {}).textContent || null, headBox: (h => h ? [Math.round(h.getBoundingClientRect().width), Math.round(h.getBoundingClientRect().height)] : null)(document.querySelector('#group-table-view .group-table-head')), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), vw: innerWidth, padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight), padT: parseFloat(cs.paddingTop), fillAbove: getComputedStyle(f).backgroundColor, frameBottom: r.bottom, navTop: document.querySelector('.phone-nav').getBoundingClientRect().top, navHeight: document.querySelector('.phone-nav').getBoundingClientRect().height, viewBottom: v.getBoundingClientRect().bottom, padB: cs.paddingBottom, frameHeight: r.height, navPadB: getComputedStyle(document.querySelector('.phone-nav')).paddingBottom, rootFont: getComputedStyle(document.documentElement).fontSize, ancestors: (() => { const rows = []; for (let n = v; n; n = n.parentElement) { const c = getComputedStyle(n), b = n.getBoundingClientRect(); rows.push({ id: n.id, tag: n.tagName, class: n.className, top: b.top, bottom: b.bottom, height: b.height, cssHeight: c.height, minHeight: c.minHeight, flex: c.flex, overflow: c.overflow, paddingBottom: c.paddingBottom }); } return rows; })() }; })()`);
    let nativeInbox = false;
    try {
        await setupHubWorld({ client, Page, Emulation, width: 390, height: 844, mobile: true, inbox: () => nativeInbox, hubPages: true });
        const failures = [];
        // The older Hub pin frames the whole Inbox in #inbox-view, rather than
        // individual folders in #group-table-view. It has no floating New button.
        for (const inset of [0, 34]) {
            await Emulation.setSafeAreaInsetsOverride({ insets: { top: 0, bottom: inset, left: 0, right: 0 } });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired();
            await waitFor(`typeof window.switchNavTab === 'function' && !!window.__coralReady`, 'the dashboard');
            await coralReady('startup', 'liveList', 'settings');
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`!!document.querySelector('#inbox-view > #inbox-frame')`, 'the whole Hub Inbox frame');
            await ev(framesJs(6));
            const p = await ev(`(() => {
                const view = document.getElementById('inbox-view'), frame = document.getElementById('inbox-frame');
                const nav = document.querySelector('.phone-nav'), fab = document.querySelector('.phone-fab');
                return { frameBottom: frame.getBoundingClientRect().bottom, navTop: nav.getBoundingClientRect().top,
                    navPadB: parseFloat(getComputedStyle(nav).paddingBottom), padB: getComputedStyle(view).paddingBottom,
                    fabShown: !!fab && getComputedStyle(fab).display !== 'none' && fab.getBoundingClientRect().height > 0 };
            })()`);
            measurements.push({ where: 'whole Inbox inset ' + inset, ...p });
            console.log('whole Inbox inset ' + inset + ' ' + JSON.stringify(p));
            await shot('whole-inbox-' + inset);
            assert.equal(p.fabShown, false, 'the Hub Inbox has no floating New button');
            assert.equal(p.navPadB, 8 + inset, 'the whole Inbox safe-area override applies');
            if (Math.abs(p.frameBottom - p.navTop) > 1) failures.push('whole Inbox inset ' + inset + ': frame bottom must meet the docked bar top ' + JSON.stringify(p));
        }
        nativeInbox = true;
        for (const [group, src] of [['needs', '/inbox/hub/needs'], ['tasks', '/inbox/hub/tasks'], ['saved', '/inbox/hub/saved']]) {
            for (const theme of ['dark', 'light']) for (const font of [16, 32]) for (const inset of [0, 34]) {
            await Emulation.setSafeAreaInsetsOverride({ insets: { top: 0, bottom: inset, left: 0, right: 0 } });
            await open(390, 844, true, group);
            await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); document.documentElement.style.fontSize = '${font}px'; true`);
            await ev(framesJs(6));
            const p = await probe();
            const local = await ev(`(() => { const v = document.getElementById('inbox-view'); return { framed: !!v.querySelector(':scope > #inbox-frame'), pad: parseFloat(getComputedStyle(v).paddingBottom) }; })()`);
            assert.equal(local.framed, false, 'native Inbox is not mistaken for the Hub frame');
            assert.ok(local.pad >= 72 + 96 + inset, 'local Inbox retains its floating-button clearance');
            assert.equal(p.src, src, `${group}: the frame is the Hub page at its constant address`);
            assert.equal(p.heading, NAMES[group], `${group}, 390: the page's heading is still in the page, for a screen reader ${JSON.stringify(p)}`);
            assert.ok(p.headBox && p.headBox[0] <= 1 && p.headBox[1] <= 1, `${group}, 390: but it is not drawn under the folder button (the button names the page) ${JSON.stringify(p)}`);
            assert.ok(p.left === 0 && p.width === p.vw, `${group}, 390: the frame runs edge to edge ${JSON.stringify(p)}`);
            assert.ok(p.padL === 0 && p.padR === 0 && p.padT === 0, `${group}, 390: no gutter round the frame ${JSON.stringify(p)}`);
            if (group === 'needs') await shot(`hub-frame-${theme}-${font}-${inset}`);
            const where = `${group} ${theme} ${font}px inset ${inset}`;
            measurements.push({ where, ...p });
            console.log(where + ' ' + JSON.stringify(p));
            if (p.frameBottom > p.navTop + 1) failures.push(where + ': frame must end above nav ' + JSON.stringify(p));
            if (Math.abs(p.frameBottom - (p.viewBottom - parseFloat(p.padB))) > 1) failures.push(where + ': frame must fit the remaining content height below the folder strip ' + JSON.stringify(p));
            assert.equal(parseFloat(p.navPadB), 8 + inset, where + ': safe-area override actually applies');
            }
            console.log(`PASS 390 ${group}: no heading, edge to edge`);
        }
        await Emulation.setSafeAreaInsetsOverride({ insets: { top: 0, bottom: 0, left: 0, right: 0 } });
        await open(1280, 800, false, 'needs');
        const d = await probe();
        assert.ok(d.heading === NAMES.needs && d.headBox[1] > 8, `1280: a desktop draws the page heading ${JSON.stringify(d)}`);
        assert.ok(d.padL > 0 && d.left > 0, `1280: and its gutter ${JSON.stringify(d)}`);
        console.log('PASS 1280: heading and gutter as before');
        if (process.env.CORAL_SCREENSHOT_DIR) fs.writeFileSync(process.env.CORAL_SCREENSHOT_DIR + '/measurements.json', JSON.stringify(measurements, null, 2));
        assert.deepEqual(failures, [], 'all framed pages clear the docked nav');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
