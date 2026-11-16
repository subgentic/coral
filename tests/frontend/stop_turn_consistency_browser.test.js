// #17066: interrupted history, completed Stop, and a later resumed turn agree at both widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const problems = [];
    const shot = async name => {
        if (!process.env.CORAL_SCREENSHOT_DIR) return;
        fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setFocusEmulationEnabled({ enabled: true });
        for (const width of [390, 1440]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`(() => { const real = window.fetch; window.__stopKeys = []; window.__continues = [];
                window.fetch = (url, opts = {}) => {
                    if (/\\/api\\/sessions\\/live\\/[^/]+\\/keys$/.test(String(url)) && opts.method === 'POST') { window.__stopKeys.push(JSON.parse(opts.body).keys); return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    if (/\\/api\\/sessions\\/live\\/[^/]+\\/send$/.test(String(url)) && opts.method === 'POST') { window.__continues.push(JSON.parse(opts.body)); return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
                    return real(url, opts);
                };
                window.__m.add('stop-proof', 'A', 6, { sleeping: false, session_id: 'stop-proof-id' });
                window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a)));
                localStorage.setItem('coral-live-view-mode', 'chat'); return true;
            })()`);
            await select('stop-proof');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'Chat rendered');
            const working = async value => ev(`(async () => {
                const m = await import((window.__coralStatic || '/static/') + 'session_header_updates.js');
                const row = window.__m.entry(Object.values(window.__m.agents).find(a => a.name === 'stop-proof'));
                const next = { ...row, session_id: 'stop-proof-id', working: ${value} }; T.state.liveSessions = [next]; Object.assign(T.state.currentSession, next); m.updateWaitingIndicator(next); return true;
            })()`);
            await working(true);
            await waitFor(width === 390 ? `document.getElementById('mobile-send-btn').classList.contains('is-stop')` : `document.getElementById('command-pane').getAttribute('data-stop-now') === 'true'`, 'Stop visible');
            await shot(`${width}-working`);
            await ev(width === 390 ? `document.getElementById('mobile-send-btn').click(); true` : `document.querySelector('#command-pane .btn-esc').click(); true`);
            await waitFor('window.__stopKeys.length === 1', 'One interrupt sent');
            assert.deepEqual(await ev('window.__stopKeys'), [['Escape']]);
            await ev(`(async()=>{const a=window.__m.agents['stop-proof-id'];a.msgs.push({type:'user',content:'[Request interrupted by user]',timestamp:new Date().toISOString()});await T.liveChat.refreshLiveHistory();return true})()`);
            await waitFor(`[...document.querySelectorAll('#live-history-messages .chat-note')].some(n=>n.textContent==='Interrupted')`,'Interrupt recorded in history');
            await working(false);
            await ev(`T.liveChat.refreshLiveHistory().then(()=>true)`);
            await waitFor(`!document.querySelector('#live-history-messages .chat-working')`,'Completed Stop removes Working');
            await waitFor(`document.getElementById('command-pane').getAttribute('data-stopping') === null`, 'Stop acknowledged');
            const feedback = await waitFor(`(() => { const t = [...document.querySelectorAll('.toast')].find(e => /Stopped/.test(e.textContent) && /keeps its task/.test(e.textContent)); return t && t.textContent; })()`, 'Visible stopped feedback', 2500).then(() => true).catch(() => false);
            if (!feedback) problems.push(width + ': no visible stopped/resume feedback');
            if (feedback) await waitFor(`(() => { const t = [...document.querySelectorAll('.toast')].find(e => /keeps its task/.test(e.textContent)); return t && getComputedStyle(t).opacity === '1'; })()`, 'Toast animation finished');
            assert.equal(await ev(`document.getElementById('command-pane').getAttribute('data-stop-now')`),'false','Idle composer has no active Stop');
            assert.equal(await ev(`getComputedStyle(document.querySelector('#command-pane .btn-esc')).display`),'none','Idle agent does not offer a grey inert Stop');
            await shot(`${width}-stopped`);
            await ev(`(async () => {
                const m = await import((window.__coralStatic || '/static/') + 'session_rows.js');
                const row = document.querySelector('.session-group-item[data-session-id="stop-proof-id"]');
                const btn = row.querySelector('.sidebar-kebab-btn'), menu = btn.nextElementSibling;
                m.openRowMenu(btn, menu);
                const first = menu.querySelector('.overflow-menu-item');
                if (first?.dataset.onClick !== 'agent-continue') throw new Error('Continue must be first after Stop');
                document.getElementById('command-input').value = 'Keep my unsent draft';
                first.click(); return true;
            })()`);
            await waitFor('window.__continues.length === 1', 'Continue submitted');
            assert.deepEqual(await ev('window.__continues[0]'), { command: 'continue', agent_type: 'claude', session_id: 'stop-proof-id' });
            assert.equal(await ev("document.getElementById('command-input').value"), 'Keep my unsent draft');
            await waitFor(`document.querySelector('.toast') && [...document.querySelectorAll('.toast')].some(e => e.textContent.includes('Continue sent'))`, 'Continue confirmation');
            await ev(`document.getElementById('command-input').value='';document.getElementById('command-input').dispatchEvent(new Event('input',{bubbles:true}));true`);
            await working(true);
            await ev(`T.liveChat.refreshLiveHistory().then(()=>true)`);
            await waitFor(`!!document.querySelector('#live-history-messages .chat-working')`,'New turn visibly resumes Working');
            assert.equal(await ev(`document.getElementById('command-pane').getAttribute('data-stopping')`),null,'Resumed turn is not still Stopping');
        }
        assert.deepEqual(problems, []);
        console.log('PASS Stop/Interrupted/Working consistency and resumed turn at 390 and 1440');
    } finally { await client.close(); }
})().catch(error => { console.error(error); process.exit(1); });
