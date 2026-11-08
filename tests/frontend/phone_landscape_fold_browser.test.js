// The chat keeps its room while typing (Mobile pass 30, #10385, #10388): in landscape the top bar, the sign-in notice and the agent's header took about 140 px of 390 (and with the keyboard up the messages had 80 px of 200). With the
// message box focused the agent header folds away too (it returns on blur), so the chat has at least 120 px with the keyboard up and about three lines of messages with it down. 844 x 390, and 844 x 200 for the keyboard.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');
const { guardSettings } = require('./helpers/settings_guard');

(async () => {
    const guard = await guardSettings();
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const rect = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width), bottom: Math.round(r.bottom) }; })()`);
    const open = async (h = 390) => {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 844, height: h, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev, 'startup', 'liveList', 'settings');
        await ev(`window.__m.add('coral-go', 'm', 8, { sleeping: false, session_id: 'o1' }); true`);
        await new Promise(r => setTimeout(r, 800)); // sleep-ok: the list renders from several answers
        await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
        await waitFor(`!!document.getElementById('command-input') && document.getElementById('command-input').getClientRects().length > 0`, 'the chat', 10000);
        await new Promise(r => setTimeout(r, 500)); // sleep-ok: the page settles
    };
    try {
        await open();
        await ev(`(()=>{const real=window.fetch;window.__noticeAckPosts=0;window.fetch=(input,options={})=>{if(new URL(String(input),location.href).pathname==='/api/launch-disclosure/ack'&&options.method==='POST')window.__noticeAckPosts++;return real(input,options)};return true})()`);
        await ev(`fetch('/api/launch-disclosure/ack',{method:'DELETE'}).then(r=>r.ok)`);
        await ev(`import((window.__coralStatic||'/static/')+'launch_disclosure.js').then(m=>m.refreshLaunchDisclosure())`);
        await waitFor(`!!document.getElementById('launch-disclosure-banner')`, 'unseen notice');
        const noticeText = await ev(`document.getElementById('launch-disclosure-banner').textContent`);
        const size = async height => { await Emulation.setDeviceMetricsOverride({width:950,height,deviceScaleFactor:1,mobile:true}); await ev(framesJs(3)); };
        await size(500);
        assert.equal(await rect('#launch-disclosure-banner'), null, 'collapsed notice is absent at the short touch boundary');
        assert.equal(await ev(`(()=>{const s=document.querySelector('#launch-disclosure-banner summary');s.focus();return document.activeElement===s})()`), false, 'folded notice cannot receive focus');
        await size(700);
        assert.ok(await rect('#launch-disclosure-banner'), 'taller view restores the notice');
        assert.equal(await ev(`document.getElementById('launch-disclosure-banner').textContent`), noticeText, 'restored text is unchanged');
        await ev(`document.querySelector('#launch-disclosure-banner summary').click();true`);
        await waitFor(`document.querySelector('#launch-disclosure-banner summary').getAttribute('aria-expanded')==='true'`, 'expanded notice');
        await size(500);
        assert.ok(await rect('#launch-disclosure-banner'), 'expanded disclosure stays visible on a short screen');
        await ev(`document.querySelector('#launch-disclosure-banner summary').click();true`);
        await waitFor(`document.querySelector('#launch-disclosure-banner summary').getAttribute('aria-expanded')==='false'`, 'collapsed notice');
        assert.equal(await rect('#launch-disclosure-banner'), null);
        if (process.env.CORAL_TEST_STRICT) {
            await ev(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_permission_mode:''})}).then(r=>r.ok)`);
            const payload = {board_name:'disclosure-fold-probe',working_dir:'/tmp/coral-disclosure-no-folder',agent_type:'claude',flags:['--permission-mode','auto'],agents:[{name:'Orchestrator',prompt:'Coordinate'}]};
            const refusal = await ev(`fetch('/api/sessions/launch-team',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(payload))}}).then(async r=>({status:r.status,body:await r.json()}))`);
            assert.equal(refusal.status,409,'folded view still hits the real authenticated launch gate');
            assert.equal(refusal.body.code,'launch_disclosure_required');
            await ev(`import((window.__coralStatic||'/static/')+'launch_core.js').then(m=>m._launchOn('local','/api/sessions/launch-team',${JSON.stringify(payload)},'claude'));true`);
            await waitFor(`document.getElementById('confirm-modal')?.getClientRects().length>0&&document.getElementById('confirm-modal-message')?.textContent===${JSON.stringify(refusal.body.disclosure.text)}`, 'full server disclosure before launch');
            assert.ok(await rect('#confirm-modal-yes'), 'explicit acknowledgement remains available in launch confirmation');
            await ev(`[...document.querySelectorAll('#confirm-modal button')].find(b=>b.textContent.trim()==='Cancel').click();true`);
            await waitFor(`!document.getElementById('confirm-modal').getClientRects().length`, 'launch cancelled');
        }
        await ev(`import((window.__coralStatic||'/static/')+'utils.js').then(m=>m.showView('mobile-agent-list'))`);
        assert.ok(await rect('#launch-disclosure-banner'), 'leaving chat restores the notice');
        assert.equal(await ev(`document.getElementById('launch-disclosure-banner').textContent`),noticeText);
        assert.equal(await ev(`fetch('/api/launch-disclosure',{cache:'no-store'}).then(r=>r.json()).then(d=>d.seen)`),false,'folding, expansion, and cancellation never mark the notice seen');
        assert.equal(await ev(`window.__noticeAckPosts`),0,'no acknowledgement request was sent');
        await ev(`window.selectLiveSession('coral-go','claude','o1','local');true`);
        await waitFor(`document.body.classList.contains('live-session-active')`, 'return to chat');
        await Emulation.setDeviceMetricsOverride({width:844,height:390,deviceScaleFactor:1,mobile:true});
        await ev(framesJs(3));
        const before = await rect('#live-history-messages');
        await ev(`document.getElementById('command-input').focus(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page folds
        const head = await rect('#live-session-view .terminal-header');
        check(!head, `while typing the agent header is folded away: ${JSON.stringify(head)}`);
        await Emulation.setDeviceMetricsOverride({ width: 844, height: 200, deviceScaleFactor: 1, mobile: true }); await new Promise(r => setTimeout(r, 500)); // sleep-ok: the layout follows the keyboard
        const kb = await rect('#live-history-messages');
        check(kb && kb.h >= 110, `with the keyboard up the chat has at least 110 px: ${JSON.stringify(kb)}`);
        await Emulation.setDeviceMetricsOverride({ width: 844, height: 390, deviceScaleFactor: 1, mobile: true }); await ev(`document.getElementById('command-input').blur(); true`); await new Promise(r => setTimeout(r, 400)); // sleep-ok: the page unfolds
        const back = await rect('#live-session-view .terminal-header');
        check(!!back, 'the agent header is back when the box loses focus');
    } finally { await guard.restore(); await client.close(); }
    assert.deepEqual(problems, [], 'fold:\n  ' + problems.join('\n  '));
    console.log('PASS fold');
})().catch(e => { console.error(e); process.exit(1); });
