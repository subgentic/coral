// The agent's artifacts table keeps its Name readable (#6751, the operator's report; the table is the team page's since #7622): Name gets the free width at every panel width, the name is one line of the row's button (the second line is the
// folded Type, Size and Task in a narrow panel), Created is short (when_text.js: just now, yesterday, a date) with the whole time as its tooltip, and below 560 px Type, Size and Task fold under the name. Measured at several panel widths on a desktop
// and on a 390 px phone, against a stubbed list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');

const HEX = c => c.repeat(64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the panel lays out after a width change; there is no completion event
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const team = 'name-team-' + Date.now();
    const now = new Date(), yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12), old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60, 12); // noon of the calendar day, so 'yesterday' is yesterday at any hour (now - 1.2 days was two days back before 04:48)
    const NAMES = ['image-2026-10-21.png', 'orchestrator-notes.md', 'a-very-long-report-name-that-keeps-going-and-going-for-a-whole-quarter-of-the-year-final-v3.txt'];
    const ITEMS = [now, yest, old].map((d, i) => ({ id: HEX('abc'[i]), name: NAMES[i], media_type: ['image/png', 'text/markdown', 'text/plain'][i], size: 1000 + i, task_id: 20 + i, task_title: 'T' + i, created_at: d.toISOString(), uri: 'coral://artifacts/' + HEX('abc'[i]), produced_by: 'orc' }));
    const measure = () => ev(`(() => [...document.querySelectorAll('#agentic-panel-artifacts tbody tr')].map(row => { const cell = row.querySelector('td'), b = row.querySelector('.dt-primary'), when = row.querySelector('td .dt-time, td time, td:nth-last-child(2) span') || row.querySelector('td:last-child span'); const lh = parseFloat(getComputedStyle(b).lineHeight) || 1.4 * parseFloat(getComputedStyle(b).fontSize); const br = b.getBoundingClientRect(); return { folded: !!row.closest('.dt-box.dt-folded'), nameW: Math.round(cell.getBoundingClientRect().width), btnH: Math.round(br.height), lh: Math.round(lh), text: b.textContent, created: when.textContent, createdTitle: when.title, tds: [...row.querySelectorAll('td')].filter(t => t.getClientRects().length).length }; }))()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__items = ${JSON.stringify(ITEMS)};
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const p = url.pathname;
                if (p.startsWith('/api/board/') && p.endsWith('/artifacts')) return json({ session_id: new URL(String(u), location.origin).searchParams.get('session_id') || undefined, project: decodeURIComponent(p.split('/')[3]), artifacts: window.__items, has_more: false, truncated: false });
                if (p === '/api/system/artifact-store/kept') return json({ kept: [] });
                if (p.startsWith('/api/')) return json({}); return R(u, o); };
            return true; })()`);
        await ev(`(async () => { const {state} = await import((window.__coralStatic||'/static/')+'state.js'); const files = await import((window.__coralStatic||'/static/')+'changed_files.js');
            state.currentSession = { type: 'live', name: 'nm-ui', session_id: 'nm-a', board_project: ${JSON.stringify(team)} };
            const {showView} = await import((window.__coralStatic||'/static/')+'utils.js'); showView('live-session-view');
            const side = document.getElementById('agentic-state'); side.classList.remove('collapsed'); side.style.width = '680px'; files.initFileSearch(); files.syncFilesViewerSession(); return true; })()`);
        await ev(`localStorage.removeItem('coral-agentic-tab-top'); document.getElementById('agentic-tab-artifacts').click(); true`);
        await waitFor(`document.querySelectorAll('#agentic-panel-artifacts tbody tr').length === 3`, 'the three rows', 8000);

        for (const w of [1000, 800, 680, 560, 480]) {
            await ev(`document.getElementById('agentic-state').style.width = '${w}px'; true`); await sleep(500); // sleep-ok: the container query re-lays the table out; nothing to wait on
            const rows = await measure(); const at = `panel ${w}px: `;
            for (const [i, r] of rows.entries()) {
                assert.ok(r.nameW >= 200, at + `the Name column keeps a readable width (>= 200 px), row ${i}: ${JSON.stringify(r)}`);
                assert.ok(r.btnH <= Math.max(44, r.lh * 1.5), at + `${i === 2 ? 'a very long name wraps to at most five lines' : 'the name is one line'}: ${r.btnH} px high`); // the table wraps a long name whole (the full name stays readable) instead of cutting it
                assert.equal(r.text, NAMES[i], at + 'the whole name is the button');
                assert.ok(r.created && r.created.length <= 20, at + 'Created is short: ' + r.created);
                assert.ok(r.createdTitle && /\d{4}|\d{1,2}:\d{2}/.test(r.createdTitle), at + 'the whole time is the tooltip');
                assert.equal(r.tds, w > 832 ? 6 : w > 576 ? 5 : w > 448 ? 4 : 3, at + `${r.folded ? 'all facts in the folded row' : 'every column'}: ${r.tds}`); // Name, Size, Created and the Details link: the agent's list has no Type or Task column since #8793 (one line per row)
            }
            if (w === 680) await shot('artifacts-name-680');
            if (w === 480) await shot('artifacts-name-480');
        }
        // a phone
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true }); await sleep(700); // sleep-ok: the viewport change reaches the page's layout
        await ev(`(() => { const side = document.getElementById('agentic-state'); side.style.width = ''; if (!side.checkVisibility()) { const t = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); t && t.click(); } document.getElementById('agentic-tab-artifacts').click(); return true; })()`);
        await waitFor(`document.querySelectorAll('#agentic-panel-artifacts tbody tr').length === 3 && document.querySelector('#agentic-panel-artifacts tbody tr').getBoundingClientRect().width > 0`, 'the rows on a phone', 8000);
        const phone = await measure();
        for (const r of phone) {
            assert.ok(r.nameW >= 150, `phone: Name keeps a readable width: ${JSON.stringify(r)}`);
            assert.ok(r.tds === 3, `phone: Name, Size, Created and the Details link, a 44 px target: ${JSON.stringify(r)}`);
        }
        await shot('artifacts-name-phone');
        console.log('PASS artifacts list: Name keeps its width');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
