// Message Board rows have no initials badge (#7315, the Operator's request): the sender's name and the message text start at the row's left edge, the name keeps its colour, the time and the grouping of
// a run from one sender stay. At 1280 px, 390 px and 200% text, in the dark and the light theme. Real board over the API. Drives Chrome over CDP against the isolated dev server; with CORAL_SCREENSHOT_DIR
// set it also saves a picture of each.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'rows-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
        for (const [id, t] of [['Orchestrator', 'Orchestrator'], ['QA Engineer', 'QA Engineer'], ['Gemini Dev', 'Developer']]) assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' }), 200);
        for (const [who, text] of [['Orchestrator', 'The release is ready for the gate.'], ['Orchestrator', 'A second line from the same sender, grouped under the first.'], ['QA Engineer', 'Gate run is green on the Mac.'], ['Gemini Dev', 'A longer message that wraps onto more than one line at a narrow width, so the left edge of every line can be seen against the row.']]) assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content: text }), 200);
        const check = async (label, w, h, mobile, zoom, theme) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: `${BASE}/board/${B}` }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`);
            await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme(${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom || '')}; return true; })()`);
            await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 4`, `${label}: the messages`, 15000);
            const r = await ev(`(() => { const rows = [...document.querySelectorAll('#mb-messages .mb-message')]; return { badges: document.querySelectorAll('#mb-messages .mb-avatar').length, rows: rows.map(m => { const mr = m.getBoundingClientRect(), b = m.querySelector('.mb-message-body').getBoundingClientRect(), n = m.querySelector('.mb-agent-name'); const nr = n.getBoundingClientRect(); return { grouped: m.classList.contains('mb-message-grouped'), body: Math.round(b.left - mr.left), name: getComputedStyle(n).display === 'none' ? null : Math.round(nr.left - mr.left), color: getComputedStyle(n).color, time: !!m.querySelector('.mb-message-time, .mb-time, time') }; }), sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            assert.equal(r.badges, 0, `${label}: no initials badge`);
            assert.equal(r.sideways, false, `${label}: nothing scrolls sideways`);
            assert.ok(r.rows.some(x => x.grouped), `${label}: a run from one sender is still grouped`);
            for (const x of r.rows) { assert.ok(x.body <= 12, `${label}: the text starts at the row's padding: ${JSON.stringify(x)}`); if (x.name !== null) assert.equal(x.name, x.body, `${label}: the name and the text share a left edge: ${JSON.stringify(x)}`); }
            assert.equal(new Set(r.rows.filter(x => !x.grouped).map(x => x.color)).size > 1, true, `${label}: names keep their colours`);
            await shot(`rows-${label}`);
        };
        for (const theme of ['dark', 'light']) {
            console.log(`${theme}: 1280, 390 and 200% text`);
            await check(`${theme}-1280`, 1280, 800, false, '', theme);
            await check(`${theme}-390`, 390, 844, true, '', theme);
            await check(`${theme}-390-200`, 390, 844, true, '200%', theme);
        }
        console.log('PASS Message Board rows have no initials badge');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(err => { console.error(err); process.exit(1); });
