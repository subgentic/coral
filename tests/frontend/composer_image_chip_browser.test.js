// (stubs as in question_card_image_browser)
// An image into the question card's answer box (#11386, the operator: "a user should be able to paste an image to this screen to direct the agent"): "Or type your own answer" takes a pasted image (or Add image) through the
// message box's own uploader, shows it as a chip with a remove button inside the card, and sends it WITH the typed words as the answer: the artifact link and the one hint to fetch it, then the text. One upload, one answer, the
// message box's strip untouched; a picture that is too big or is not one is refused in words. The fetches and the feed are stubbed. 1280 and 390 px.
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
            await ev(`import((window.__coralStatic || '/static/') + 'image_composer.js').then(async m => { const s = await import((window.__coralStatic || '/static/') + 'state.js'); const f = new File([Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }); await m.uploadAndInsertImage(f, s.state.currentSession); return true; })`);
            await waitFor(`!!document.querySelector('#image-attachments .image-attachment')`, `${at}: the composer's chip`, 8000);
            const m = await ev(`(() => { const bar = document.getElementById('image-attachments'), chip = bar.querySelector('.image-attachment'), cs = getComputedStyle(bar); const r = e => e.getBoundingClientRect(); return { bg: cs.backgroundColor, border: cs.borderBottomWidth, barH: Math.round(r(bar).height), chipH: Math.round(r(chip).height) }; })()`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/composer-chip-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            // the strip is the chip and nothing painted around it: no grey band across the composer, no rule under it, a row no taller than its chip
            if (!(m.bg === 'rgba(0, 0, 0, 0)' || m.bg === 'transparent')) problems.push(`${at}: the strip paints a band behind the chip (${m.bg}): ${JSON.stringify(m)}`);
            if (m.border !== '0px') problems.push(`${at}: the strip has a rule under it (${m.border}): ${JSON.stringify(m)}`);
            if (m.barH > m.chipH + 12) problems.push(`${at}: the strip is much taller than its chip: ${JSON.stringify(m)}`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS the composer image chip has no band behind it, on a phone or a desktop');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
