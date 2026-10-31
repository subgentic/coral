// (stubs as in question_card_image_browser)
// An image into the question card's answer box (#11386, the operator: "a user should be able to paste an image to this screen to direct the agent"): "Or type your own answer" takes a pasted image (or Add image) through the
// message box's own uploader, shows it as a chip with a remove button inside the card, and sends it WITH the typed words as the answer: the artifact link and the one hint to fetch it, then the text. One upload, one answer, the
// message box's strip untouched; a picture that is too big or is not one is refused in words. The fetches and the feed are stubbed. 1280 and 390 px.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SID = crypto.randomUUID();
const HEX = crypto.randomBytes(32).toString('hex');
const SESSIONS = [{ name: 'coral-go', display_name: 'Lead Dev', agent_type: 'claude', session_id: SID, summary: 'Working', working_directory: '/repo/coral-go' }];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STUB = `
  (function(){ const Real = window.WebSocket; function Dead(u){ this.url=String(u); this.readyState=0; } Dead.prototype.send=function(){}; Dead.prototype.close=function(){}; Dead.prototype.addEventListener=function(){}; Dead.prototype.removeEventListener=function(){};
    function W(u,p){ if (/\\/ws\\//.test(String(u))) return new Dead(u); return p===undefined? new Real(u): new Real(u,p); } W.prototype=Real.prototype; W.CONNECTING=0; W.OPEN=1; W.CLOSING=2; W.CLOSED=3; window.WebSocket=W; })();
  window.__origFetch = window.fetch.bind(window); window.__answers = []; window.__uploads = 0;
  window.fetch = (url, opts) => { const u=String(url); const rel=u.replace(/^https?:\\/\\/[^/]+/,''); const path=rel.split('?')[0]; const m=((opts&&opts.method)||'GET').toUpperCase();
    const json=(b)=>Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}));
    if (m==='POST' && /\\/answer-prompt$/.test(path)) { window.__answers.push(JSON.parse(opts.body)); return json({ ok: true }); }
    if (path === '/api/upload') { window.__uploads++; return new Promise(r => setTimeout(r, window.__uploadDelay || 30)).then(() => json({ path: '/home/me/.coral/uploads/shot.png', filename: 'shot.png', artifact: { uri: 'coral://artifacts/${HEX}' } })); }
    if (path==='/api/sessions/live') return json(window.__sessions);
    if (/^\\/api\\/sessions\\/live\\/[^/]+\\/chat$/.test(path)) return json({ messages: [{ type: 'user', content: 'Plan it.' }], total: 1, has_more: false, pending: window.__pendingTool || null, ...(window.__promptScreen ? { prompt_options: window.__promptScreen } : {}) });
    if (m!=='GET') return json({ok:true});
    if (/^\\/api\\/board\\//.test(path)) return json({});
    return window.__origFetch(url, opts); };`;



(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
            const at = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'history', 'settings');
            await ev(`window.__sessions = ${JSON.stringify(SESSIONS)}; window.switchNavTab('agents'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__sessions))); true`);
            await ev(`Promise.resolve(window.selectLiveSession('coral-go', 'claude', ${JSON.stringify(SID)})).then(() => { window.setLiveViewMode('chat'); return true; })`);
            await coralReady(ev, 'agentSelected', SID);
            await waitFor(`!!document.querySelector('#live-session-view .terminal-header[data-folder]')`, `${at}: the header knows the folder`, 8000);
            // the name takes the focus from the page's own script, as when an agent opens or after a send: no tip over the chat, on a phone or a computer
            await ev(`document.getElementById('terminal-header-identity').focus(); true`);
            const tip = () => ev(`getComputedStyle(document.querySelector('#live-session-view .terminal-header'), '::after').content`);
            const shown = c => c && c !== 'none' && c !== 'normal';
            if (shown(await tip())) problems.push(`${at}: the folder tip shows after the page's own script put the focus on the name: ${await tip()}`);
            // a key puts the focus there (a key goes first, then the focus): the keyboard's tip is shown, as before
            await ev(`document.getElementById('terminal-header-identity').blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); document.getElementById('terminal-header-identity').focus(); true`);
            if (!shown(await tip())) problems.push(`${at}: the keyboard's folder tip is gone: ${await tip()}`);
            // a tap takes the keyboard's state away: the next script focus shows nothing
            await ev(`document.getElementById('terminal-header-identity').blur(); document.dispatchEvent(new Event('touchstart', { bubbles: true })); document.getElementById('terminal-header-identity').focus(); true`);
            if (shown(await tip())) problems.push(`${at}: the folder tip shows on a script focus after a touch: ${await tip()}`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS the folder tip is the keyboard\'s and the mouse\'s, not a touch screen\'s');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
