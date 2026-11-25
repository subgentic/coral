// Settings > Notifications through a Hub on a phone (#21268, the Hub Operator's screenshot): no Reset drawn over the "Show notifications in Coral" title, no "What reaches Needs you" heading over nothing (the Hub keeps only the
// computer's rows out of it), a Learn more that leaves no gap in its hint, and one row at the top, only when Hub-served, that sends the person to the Hub's own /account#push-panel (same origin, a plain link) for phone
// pushes: these switches are this tab's own alerts. At 390 and 430, dark. A Coral that is not a Hub has none of the Hub row and keeps its Needs you rows. Shots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { setupHubWorld, BASE } = require('./helpers/hub_world');
const { coralReady, nextFrame } = require('./helpers/wait');

const MEASURE = `(() => { const pane = document.getElementById('settings-pane-notifications'), I = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1, vis = e => e && e.offsetParent !== null;
    const rows = [...pane.querySelectorAll('.sv-row')].filter(vis);
    const overlaps = [], resets = [];
    for (const r of rows) { const b = r.querySelector('.settings-reset:not([hidden]) .btn'); if (!b) continue; resets.push(r.querySelector('.sv-label')?.textContent);
        const name = r.querySelector('.sv-label'); for (const rc of name.getClientRects()) if (I(rc, b.getBoundingClientRect())) overlaps.push(name.textContent + ' under Reset');
        const help = r.querySelector('.sv-help'); if (help && I(help.getBoundingClientRect(), b.getBoundingClientRect())) overlaps.push(name.textContent + ' hint under Reset'); }
    const desk = document.getElementById('settings-desktop-notify').closest('.sv-row'), hp = desk.querySelector('.sv-help'), lh = parseFloat(getComputedStyle(hp).lineHeight);
    const tops = new Set(); for (const n of hp.querySelectorAll('.sv-help-text, .sv-learn')) { const rg = document.createRange(); rg.selectNodeContents(n); for (const rc of rg.getClientRects()) tops.add(Math.round(rc.top / 4)); }
    const block = document.getElementById('settings-pane-needs-you'), hub = document.getElementById('settings-hub-push'), alerts = ['settings-alert-needs-input', 'settings-alert-reply'].map(id => document.getElementById(id).closest('.sv-row').querySelector('.sv-help').textContent);
    const mine = hub && hub.closest('.sv-row'), first = rows[0];
    return { resets, overlaps, helpH: hp.getBoundingClientRect().height, lines: tops.size, lh, blockShown: vis(block), blockRows: [...block.querySelectorAll('.sv-row')].filter(vis).length, alerts,
        hub: hub && { href: hub.getAttribute('href'), abs: hub.href, text: hub.textContent, title: mine.querySelector('.sv-label')?.textContent, first: mine === first, shown: vis(hub) && hub.getBoundingClientRect().width > 80, right: hub.getBoundingClientRect().right, vw: innerWidth, origin: location.origin },
        scrollW: document.getElementById('settings-modal').querySelector('.settings-panes').scrollWidth - document.getElementById('settings-modal').querySelector('.settings-panes').clientWidth }; })()`;

(async () => {
    const problems = [];
    const shot = async (Page, n) => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async ({ ev, waitFor }) => { await coralReady(ev, 'startup', 'settings'); await ev(`(async () => { await window.showSettingsModal('notifications'); return true; })()`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none' && !!document.getElementById('settings-desktop-notify') && document.querySelectorAll('#settings-pane-notifications .settings-reset:not([hidden])').length > 0`, 'Notifications with a Reset'); await ev(`document.fonts.ready.then(() => true)`); await nextFrame(ev); };
    // the Hub
    {
        const h = await connect(); const { client, Page, Emulation, ev } = h;
        try {
            for (const w of [390, 430]) {
                await setupHubWorld({ client, Page, Emulation, width: w, height: 900, mobile: true });
                await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname; if (p === '/api/settings' && (o.method || 'GET') === 'GET') return Promise.resolve(Response.json({ settings: { notify_needs_input: true } })); return R(u, o); }; })();` });
                await Emulation.setEmulatedMedia({ features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await open(h);
                const m = await ev(MEASURE); const tag = `hub ${w}`;
                await shot(Page, `notifications-hub-${w}`);
                if (!m.resets.length) problems.push(`${tag}: no Reset is shown, so the overlap is not tested`);
                if (m.overlaps.length) problems.push(`${tag}: text under a Reset: ${m.overlaps}`);
                if (m.blockShown && !m.blockRows) problems.push(`${tag}: What reaches Needs you is shown with no rows`);
                if (m.helpH > m.lines * m.lh + 6) problems.push(`${tag}: the Desktop alerts hint is ${Math.round(m.helpH)} px for ${m.lines} lines of ${m.lh} px`);
                if (!m.alerts.every(t => /tab open/i.test(t))) problems.push(`${tag}: the Alert rows do not say the tab must be open ${JSON.stringify(m.alerts)}`);
                if (!m.hub) problems.push(`${tag}: no Phone notifications row`);
                else {
                    if (m.hub.href !== '/account#push-panel' || m.hub.abs !== m.hub.origin + '/account#push-panel') problems.push(`${tag}: the link goes to ${m.hub.abs}`);
                    if (m.hub.title !== 'Phone notifications' || m.hub.text !== 'Turn on in your Hub account') problems.push(`${tag}: row words are "${m.hub.title}" / "${m.hub.text}"`);
                    if (!m.hub.first) problems.push(`${tag}: the Hub row is not first`);
                    if (!m.hub.shown || m.hub.right > m.hub.vw) problems.push(`${tag}: the Hub row is not on screen ${JSON.stringify(m.hub)}`);
                }
                if (m.scrollW > 1) problems.push(`${tag}: the pane scrolls sideways by ${m.scrollW}`);
            }
        } finally { await client.close(); }
    }
    // a Coral that is not a Hub
    {
        const h = await connect(); const { client, Page, Emulation, ev } = h;
        try {
            await Emulation.setDeviceMetricsOverride({ width: 390, height: 900, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
            await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: h.PRELOAD });
            await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const R = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href).pathname; if (p === '/api/settings' && (o.method || 'GET') === 'GET') return R(u, o).then(async r => { const j = await r.json(); return Response.json({ ...j, notify_needs_input: true, settings: { ...(j.settings || {}), notify_needs_input: true } }); }); return R(u, o); }; })();` });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await h.install(); await open(h);
            const m = await ev(MEASURE);
            if (m.hub) problems.push('local: the Hub row shows on a Coral that is not a Hub');
            if (!m.blockShown || m.blockRows < 3) problems.push(`local: What reaches Needs you has ${m.blockRows} rows`);
            if (m.overlaps.length) problems.push(`local: text under a Reset: ${m.overlaps}`);
            await shot(Page, 'notifications-local-390');
        } finally { await client.close(); }
    }
    assert.deepEqual(problems, [], 'Notifications through a Hub:\n  ' + problems.join('\n  '));
    console.log('PASS Notifications: no text under Reset, no empty Needs you heading, a tight hint, the Hub row only when Hub-served');
})().catch(e => { console.error(e); process.exit(1); });
