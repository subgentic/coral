// Message Board rows have no initials badge (#7315, the Operator's request): the sender's name and the message text start at the row's left edge, the name keeps its colour, the time and the grouping of
// a run from one sender stay. At 1280 px, 390 px and 200% text, in the dark and the light theme. Real board over the API. Drives Chrome over CDP against the isolated dev server; with CORAL_SCREENSHOT_DIR
// set it also saves a picture of each.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'rows-' + Date.now().toString(36);
    const api = (m, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(m)}, headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: "try { localStorage.setItem('coral.board.view', 'chat'); } catch (e) {}" }); // the chat rows: the team page's Board tab is the table by default (#8129)
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        for (const [id, t] of [['Orchestrator', 'Orchestrator'], ['QA Engineer', 'QA Engineer'], ['Gemini Dev', 'Developer']]) assert.equal(await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: t, session_name: id + '-s' }), 200);
        for (const [who, text] of [['Orchestrator', 'The release is ready for the gate.'], ['Orchestrator', 'A second line from the same sender, grouped under the first.'], ['QA Engineer', 'Gate run is green on the Mac.'], ['Gemini Dev', 'A longer message that wraps onto more than one line at a narrow width, so the left edge of every line can be seen against the row.']]) assert.equal(await api('POST', `/api/board/${B}/messages`, { subscriber_id: who, content: text }), 200);
        const check = async (label, w, h, mobile, zoom, theme) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: `${BASE}/board/${B}` }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme(${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom || '')}; return true; })()`);
            await waitFor(`document.querySelectorAll('#mb-messages .mb-message').length >= 4`, `${label}: the messages`, 15000);
            const r = await ev(`(() => { const rows = [...document.querySelectorAll('#mb-messages .mb-message')]; const composer = document.getElementById('mb-post-input').getBoundingClientRect().bottom; const si = document.querySelector('input[placeholder="Search the board"]'), sr = si && si.getBoundingClientRect(), fb = [...document.querySelectorAll('.mb-search-toggle, .list-bar-filter-btn')].find(b => b.getBoundingClientRect().width > 0); const search = sr && sr.width > 0 ? sr.left : fb.getBoundingClientRect().left; /* a phone has the search as a button row (#7183): the bar's own left edge then */ return { below: Math.round(innerHeight - composer), search: Math.round(search), badges: document.querySelectorAll('#mb-messages .mb-avatar').length, rows: rows.map((m, i) => { const mr = m.getBoundingClientRect(), b = m.querySelector('.mb-message-body').getBoundingClientRect(), n = m.querySelector('.mb-agent-name'); const nr = n.getBoundingClientRect(); const prev = rows[i - 1] && rows[i - 1].querySelector('.mb-message-body').getBoundingClientRect(); return { abs: Math.round(b.left), gap: prev ? Math.round(b.top - prev.bottom) : null, grouped: m.classList.contains('mb-message-grouped'), body: Math.round(b.left - mr.left), name: getComputedStyle(n).display === 'none' ? null : Math.round(nr.left - mr.left), color: getComputedStyle(n).color, time: !!m.querySelector('.mb-message-time, .mb-time, time') }; }), sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
            assert.equal(r.badges, 0, `${label}: no initials badge`);
            assert.equal(r.sideways, false, `${label}: nothing scrolls sideways`);
            if (mobile) assert.ok(r.below <= 40, `${label}: the composer sits at the bottom of the screen, not above an empty band (${r.below} px below it)`);
            assert.ok(r.rows.some(x => x.grouped), `${label}: a run from one sender is still grouped`);
            for (const x of r.rows) {
                assert.ok(x.abs - r.search >= 0 && x.abs - r.search <= 8, `${label}: the text starts at the search field's left edge (${r.search}), at most the row's 8 px padding inside it (the team page's Board tab, #8129): ${JSON.stringify(x)}`);
                if (x.name !== null) assert.equal(x.name, x.body, `${label}: the name and the text share a left edge: ${JSON.stringify(x)}`);
                if (x.grouped) assert.ok(x.gap !== null && x.gap <= 28, `${label}: a follow-up sits right under the line above it, not a header's height below: ${JSON.stringify(x)}`);
            }
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
