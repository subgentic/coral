// A short dialog does not scroll (#9878, the operator: the New Terminal dialog showed a vertical scrollbar though its content fits). For each of the launch dialog's pages (chooser, agent, team, terminal) and Open folder, at 1280 x 900: no element inside the dialog is a scroll
// container (overflow auto or scroll) whose content is taller than its box while the dialog is shorter than the window: a dialog scrolls only when the window cannot hold it. The cause in the terminal page: the footer's -24 px bottom margin (a bleed into the dialog's padding)
// put its box 24 px below the page's scroll area. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const found = [];
    const probe = (id) => ev(`(() => { const m = document.getElementById(${JSON.stringify(id)}), c = m.querySelector('.modal-content'); if (!m || m.style.display === 'none' || !c.getClientRects().length) return null;
        const bad = [c, ...c.querySelectorAll('*')].filter(e => e.getClientRects().length && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).map(e => (e.id || String(e.className)).slice(0, 40) + ' ' + e.scrollHeight + '/' + e.clientHeight);
        return { dialogH: Math.round(c.getBoundingClientRect().height), windowH: innerHeight, bad }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
        const settle = () => new Promise(r => setTimeout(r, 500)); // sleep-ok: the page of the dialog is drawn
        for (const type of ['chooser', 'agent', 'team', 'terminal']) {
            await ev(`window.showLaunchModal(); ${type === 'chooser' ? '' : `window._selectLaunchType('${type}');`} true`); await settle();
            const r = await probe('launch-modal');
            if (!r) found.push(`launch ${type}: the dialog is not showing`); else if (r.dialogH < r.windowH - 40 && r.bad.length) found.push(`launch ${type}: a ${r.dialogH} px dialog in a ${r.windowH} px window has a scrolling part: ${r.bad.join(' | ')}`);
            await ev(`window.hideLaunchModal(); true`);
        }
        const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
        await ev(`window.showLaunchModal(); window._selectLaunchType('terminal'); true`); await settle(); await shot('dialog-terminal-1280');
        // a window too short for it: the page scrolls then, and the footer with Launch stays in view at the dialog's bottom
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 420, deviceScaleFactor: 1, mobile: false }); await settle();
        const short = await ev(`(() => { const st = document.getElementById('launch-step-terminal'), act = st.querySelector('.modal-actions'), b = act.querySelector('.btn-primary, .btn:last-child'), r = b.getBoundingClientRect(), c = document.querySelector('#launch-modal .modal-content').getBoundingClientRect(); return { scrolls: st.scrollHeight > st.clientHeight + 1, inView: r.bottom <= innerHeight && r.top >= 0, insideDialog: r.bottom <= c.bottom + 1, label: b.textContent.trim() }; })()`);
        await shot('dialog-terminal-1280x420');
        if (!short.scrolls || !short.inView || !short.insideDialog) found.push('launch terminal in a 420 px window: the page scrolls and the footer button stays in view inside the dialog: ' + JSON.stringify(short));
        await ev(`window.hideLaunchModal(); true`); await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await settle();
        await ev(`window.showOpenFolderModal(); true`); await settle();
        const f = await probe('open-folder-modal');
        if (!f) found.push('Open folder: the dialog is not showing'); else if (f.dialogH < f.windowH - 40 && f.bad.length) found.push(`Open folder: a ${f.dialogH} px dialog has a scrolling part: ${f.bad.join(' | ')}`);
    } finally { await client.close(); }
    assert.deepEqual(found, [], 'a dialog scrolls though its content fits:\n  ' + found.join('\n  '));
    console.log('PASS the launch dialog pages and Open folder do not scroll when the window holds them');
})().catch(e => { console.error(e); process.exit(1); });
