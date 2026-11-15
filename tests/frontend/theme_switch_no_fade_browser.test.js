// #16961 (walks 43 and 47, F2): a page that changes theme shows buttons and tabs in the other theme's colours for a moment (every control fades over 150 ms), so a screenshot or a glance right after the change sees dark buttons with faint text on light.
// A change of theme (the browser's light or dark with "system", or the choice in Settings) is one jump: the colours are the new theme's on the next frame. Desktop 1440 and phone 390, Inbox, dark to light and back.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { INBOX_WORLD } = require('./helpers/inbox_world');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const S = `(window.__coralStatic || '/static/')`;

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const media = v => Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: v }] });
        const paint = () => ev(`(() => { const q = s => document.querySelector(s); const out = {}; for (const [k, s] of [['tab', '.nav-tab.active, [role=tab][aria-selected=true]'], ['btn', '#inbox-local .btn, #group-table-view .btn, .btn'], ['row', '.sidebar-pane[data-pane="hub-inbox"] .sidebar-item.active, .inbox-nav-item.active, .sidebar-pane .active']]) { const e = q(s); if (e) { const c = getComputedStyle(e); out[k] = c.color + ' on ' + c.backgroundColor; } } return out; })()`);
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await media('light'); await ev(`try { localStorage.removeItem('coral-theme'); } catch (_) {} true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(INBOX_WORLD);
            await ev(`localStorage.removeItem('coral.inbox.tab'); window.switchNavTab('hub-inbox'); import(${S} + 'inbox_tab.js').then(m => m.updateInboxTab()).then(() => m.selectInboxTab ? 0 : 0).catch(() => 0); true`);
            await new Promise(r => setTimeout(r, 800)); // sleep-ok: the Inbox paints
            for (const [from, to] of [['light', 'dark'], ['dark', 'light']]) {
                await media(from); await new Promise(r => setTimeout(r, 1200)); // sleep-ok: the page follows and settles
                assert.equal(await ev(`document.documentElement.getAttribute('data-theme')`), from, `${w}: the page follows the browser to ${from}`);
                await media(to);
                await ev(`(async () => { await ${framesJs(2)}; return true; })()`); // two frames: the change has been drawn
                const now = await paint();
                if (process.env.SHOT_DIR) { require('node:fs').mkdirSync(process.env.SHOT_DIR, { recursive: true }); require('node:fs').writeFileSync(`${process.env.SHOT_DIR}/two-frames-after-${from}-to-${to}-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
                await new Promise(r => setTimeout(r, 1200)); // sleep-ok: any fade would be over
                const settled = await paint();
                assert.ok(Object.keys(settled).length >= 2, `${w}: the audit found the controls: ${JSON.stringify(settled)}`);
                assert.deepEqual(now, settled, `${w} ${from} to ${to}: two frames after the change every control already has the new theme's colours`);
            }
        }
        console.log('PASS a change of theme is one jump');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
