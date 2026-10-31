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
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const toasts = () => ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent.replace(/\\s+/g, ' ').trim())`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w} px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'history', 'settings');
            await ev(`window.__sessions = ${JSON.stringify(SESSIONS)}; window.switchNavTab('agents'); window._coralSetLiveSessions(JSON.parse(JSON.stringify(window.__sessions))); true`);
            await ev(`Promise.resolve(window.selectLiveSession('coral-go', 'claude', ${JSON.stringify(SID)})).then(() => { window.setLiveViewMode('chat'); return true; })`);
            await coralReady(ev, 'agentSelected', SID);
            await ev(`window.__pendingTool = { tool_use_id: 'q1', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which layout?', options: [{ label: 'Compact' }, { label: 'Roomy' }] }] } };
                window.__promptScreen = { question: 'Which layout?', options: [{ n: 1, label: 'Compact', selected: true, action: 'select' }, { n: 2, label: 'Roomy', action: 'select' }, { n: 3, label: 'Type something.', action: 'text' }, { n: 4, label: 'Chat about this', action: 'chat' }] }; window.__answers = []; window.__uploads = 0; true`);
            await waitFor(`!!document.querySelector('#live-history-messages .cni-text-form[data-n="3"]')`, `${at}: the question card with its answer box`, 15000);
            const F = `document.querySelector('#live-history-messages .cni-text-form[data-n="3"]')`;
            // pasting a picture into the answer box: one upload, a chip in the card, nothing in the message box's strip
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' })); const i = ${F}.querySelector('.cni-text-input'); i.focus(); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
            await waitFor(`${F}.querySelectorAll('.cni-attach .image-attachment').length === 1`, `${at}: the pasted image's chip in the card`, 8000);
            const chip = await ev(`(() => { const f = ${F}, c = f.querySelector('.cni-attach'); const r = c.getBoundingClientRect(), i = f.querySelector('.cni-text-input').getBoundingClientRect(); return { shown: !c.hidden && r.height > 0, above: r.bottom <= i.top + 1, remove: !!c.querySelector('.cni-attach-remove'), removeName: c.querySelector('.cni-attach-remove').getAttribute('aria-label'), strip: document.getElementById('image-attachments') ? document.getElementById('image-attachments').children.length : 0, uploads: window.__uploads }; })()`);
            check(chip.shown && chip.above && chip.remove, `${at}: the chip shows above the box with a remove button: ${JSON.stringify(chip)}`);
            check(chip.strip === 0 && chip.uploads === 1, `${at}: the message box's strip is untouched and the image went up once: ${JSON.stringify(chip)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await ev(`${F}.scrollIntoView({ block: 'center' }); true`); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/question-card-image-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            // the chip survives the card being drawn again (the terminal's screen changed)
            await ev(`window.__promptScreen = { ...window.__promptScreen, title: 'Redrawn' }; true`);
            await waitFor(`!!${F} && ${F}.querySelectorAll('.cni-attach .image-attachment').length === 1`, `${at}: the chip stays when the card is drawn again`, 8000);
            // too big, and not a picture: refused in words, nothing uploaded
            await ev(`(() => { const i = ${F}.querySelector('.cni-text-input'); const paste = file => { const dt = new DataTransfer(); dt.items.add(file); i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); };
                paste(new File([new Uint8Array(23 * 1024 * 1024)], 'huge.png', { type: 'image/png' })); paste(new File([new Uint8Array(10)], 'photo.heic', { type: 'image/heic' })); return true; })()`);
            await waitFor(`document.querySelectorAll('.toast').length >= 2`, `${at}: two refusals`, 8000);
            const said = (await toasts()).join(' | ');
            check(/That image is over 20 MB/.test(said) && /can't read HEIC/.test(said), `${at}: an oversized and a HEIC picture are refused in words: ${said}`);
            check((await ev(`window.__uploads`)) === 1 && (await ev(`${F}.querySelectorAll('.cni-attach .image-attachment').length`)) === 1, `${at}: the refused ones were not uploaded or attached`);
            // typed words plus the image: ONE answer with the link and the hint first
            await ev(`(() => { ${F}.querySelector('.cni-text-input').value = 'Use the second layout, like this'; ${F}.requestSubmit(); return true; })()`);
            await waitFor(`window.__answers.length === 1`, `${at}: the answer is sent`, 8000);
            const a = (await ev(`window.__answers`))[0];
            check(a.n === 3 && a.label === 'Type something.' && a.text.startsWith(`coral://artifacts/${HEX} (To read the image(s) above, run first: coral-agent artifact download coral://artifacts/${HEX}`) && a.text.endsWith('Use the second layout, like this'), `${at}: the answer is the link, the hint, then the words: ${JSON.stringify(a)}`);
            await waitFor(`!${F} || ${F}.querySelectorAll('.cni-attach .image-attachment').length === 0`, `${at}: the chip goes once the answer is sent`, 8000);
            // Add image (the phone's way): a picked file takes the same road; remove takes it out again
            await ev(`window.__answers = []; window.__uploads = 0; window.__pendingTool = { ...window.__pendingTool, tool_use_id: 'q2' }; window.__promptScreen = { ...window.__promptScreen, title: 'Second' }; true`);
            await waitFor(`!!${F}`, `${at}: the card again`, 8000);
            check(await ev(`!!${F}.querySelector('.cni-attach-btn') && ${F}.querySelector('.cni-attach-btn').getAttribute('aria-label') === 'Add image' && ${F}.querySelector('.cni-attach-btn').getBoundingClientRect().height >= ${mobile ? 44 : 24} && ${F}.querySelector('.cni-attach-btn').getBoundingClientRect().width >= ${mobile ? 44 : 28}`), `${at}: an Add image button is there${mobile ? ' and a 44 px target' : ''}`);
            await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(PNG)}), c => c.charCodeAt(0))], 'pick.png', { type: 'image/png' })); const inp = ${F}.querySelector('.cni-attach-input'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`${F}.querySelectorAll('.cni-attach .image-attachment').length === 1`, `${at}: a picked image's chip`, 8000);
            await ev(`${F}.querySelector('.cni-attach-remove').click(); true`);
            await waitFor(`${F}.querySelectorAll('.cni-attach .image-attachment').length === 0`, `${at}: remove takes the chip out`, 4000);
            await ev(`(() => { ${F}.querySelector('.cni-text-input').value = 'just words'; ${F}.requestSubmit(); return true; })()`);
            await waitFor(`window.__answers.length === 1`, `${at}: words only are sent as before`, 8000);
            check((await ev(`window.__answers`))[0].text === 'just words', `${at}: with no image the answer is only the words`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS an image pasted or added into the question card goes with the typed answer, once');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
