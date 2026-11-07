// #14371 (UI Reviewer's SHOULD on #14360): the Resume dialog's Resume in picker, for a Pi chat. Pi has no permission flag, so the picker is one fixed line, 'No permission modes', disabled, with Pi's own reason under it
// (not 'Saved default (Auto)' and 'Default', which would change nothing); a Claude chat keeps its choices, and the picker is given back after a Pi chat. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const quiet = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the dialog fills after its async reads
    const WHY = 'Pi has no permission prompts: it always acts on its own.';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => { const url = new URL(String(u), location.href); const m = url.pathname.match(/\\/api\\/sessions\\/history\\/([^/]+)\\/resume-info$/);
                if (m) return Promise.resolve(new Response(JSON.stringify({ working_dir: '/work/project', working_dir_from: 'session', working_dir_exists: true, agent_type: m[1] === 'pi-chat' ? 'pi' : 'claude', permission_mode: m[1] === 'pi-chat' ? '' : 'plan', permission_mode_from: 'session' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return R(u, o); }; return true; })()`);
            const open = type => ev(`(async () => { const st = await import((window.__coralStatic || '/static/') + 'state.js'); const id = ${JSON.stringify(type === 'pi' ? 'pi-chat' : 'claude-chat')};
                st.state.currentSession = { type: 'history', name: id, agent_type: ${JSON.stringify(type)} }; st.state.historySessionsList = [{ session_id: id, source_type: ${JSON.stringify(type)} }];
                const m = await import((window.__coralStatic || '/static/') + 'resume_dialog.js'); await m.showResumeModal(); return true; })()`).then(() => quiet(500)).then(() => ev(`(() => { const s = document.getElementById('resume-mode'); const n = document.getElementById('resume-mode-note'); return { options: [...s.options].map(o => o.textContent), value: s.value, disabled: s.disabled, title: s.title, note: n.hidden ? '' : n.textContent, rowHidden: document.getElementById('resume-mode-row').hidden }; })()`));
            let m = await open('pi');
            console.log(`${w}px Pi:`, JSON.stringify(m));
            assert.deepEqual(m.options, ['No permission modes'], `${w}px: Pi's picker is one line`);
            assert.equal(m.disabled, true, `${w}px: and disabled`);
            assert.equal(m.value, '', `${w}px: it sends no mode`);
            assert.equal(m.note, WHY, `${w}px: Pi's reason is under it`);
            assert.equal(m.title, WHY, `${w}px: and on the select`);
            assert.equal(m.rowHidden, false, `${w}px: the row is shown`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); const { data } = await Page.captureScreenshot({ format: 'png' }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/resume-pi-${w}.png`, Buffer.from(data, 'base64')); }
            m = await open('claude');
            assert.equal(m.disabled, false, `${w}px: a Claude chat's picker is open again`);
            assert.ok(m.options.length > 2 && m.options.some(t => /^Saved default/.test(t)) && m.options.includes('Plan'), `${w}px: and lists its modes: ${m.options}`);
            assert.equal(m.title, '', `${w}px: the Pi reason is gone`);
            assert.match(m.note, /Resumes in Plan mode/, `${w}px: and its own note is back: ${m.note}`);
        }
        console.log('resume_pi_modes: ok');
    } finally { await client.close(); }
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
