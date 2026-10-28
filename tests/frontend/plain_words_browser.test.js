// Plainer words on first contact (#10074, Desktop #10115's table): Home's Open folder and the Hub card say what they are for without jargon, the agent list's and the Archived folder's empty lines say what to do next. Each line is asserted
// as the person reads it; the words of the password note, the Persona step, the Archive question and the Still working line are asserted in their own suites (auth page goldens, new_agent_steps, confirm_style, first_reply_wait).
// 1280 and 390 px; isolated dev server over CDP.
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    const S = `(window.__coralStatic || '/static/')`;
    const text = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const tag = `${w}px`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
            await sleep(700); // sleep-ok: Home draws after the first reads
            if (!mobile) {
                const open = await text('#welcome-open-folder .welcome-launch-copy');
                check(`${tag}: Open folder says what it is for`, open === 'Open folder Add a project folder to start agents in later.', open);
                await ev(`(() => { const h = document.querySelector('.editions-home'); if (h) h.hidden = false; return true; })()`);
                const hub = await ev(`(() => { const q = s => (document.querySelector(s) || {}).textContent; const items = [...document.querySelectorAll('.editions-home-copy')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()); return { title: (q('#editions-home-title') || '').trim(), items }; })()`);
                check(`${tag}: the Hub card says what it gives (your agents on a phone or another computer), in plain words`, hub.title === 'Use your agents from your phone or another computer' && hub.items[0] === 'Coral Hub Open your agents in any browser, including your phone. Invite-only beta.' && /^Run your own hub Or host it yourself: connect your own machines with coral --hub\./.test(hub.items[1] || ''), JSON.stringify(hub));
                await shot('plain-words-home-1280');
            }
            // the agent list with a filter that matches nothing
            await ev(`window.__m.add('only-agent', 'O', 2, { sleeping: false }); window.T.render.renderLiveSessions(window.T.state.liveSessions); true`);
            await sleep(400); // sleep-ok: the list draws
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = 'zzz-matches-nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('#live-sessions-list .empty-plain, #mobile-session-list .empty-plain')`, 'the empty list line', 6000);
            const none = await ev(`(document.querySelector('#live-sessions-list .empty-plain') || document.querySelector('#mobile-session-list .empty-plain') || {}).textContent`);
            check(`${tag}: a search that matches no agent says what to do`, /^No agents match zzz-matches-nothing\. Clear search$/.test((none || '').trim().replace(/\s+/g, ' ')), String(none));
            await ev(`(() => { const i = document.getElementById('agent-search-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
            // the Archived folder, empty
            await ev(`Promise.all([import(${S} + 'nav.js')]).then(([n]) => n.go({ view: 'inbox-folder', folder: 'chats-archived' })).then(() => true)`);
            await waitFor(`!!document.querySelector('#group-table-view .empty-state-line') && !/^Loading/.test(document.querySelector('#group-table-view .empty-state-line').textContent)`, 'the empty line', 10000);
            const arch = await text('#group-table-view .empty-state-line');
            check(`${tag}: the empty Archived folder says what puts a chat there`, arch === 'No archived chats yet. Archive a chat or an agent and it is kept here.', arch);
            await shot(`plain-words-archived-${w}`);
        }
    } finally { await client.close(); }
    if (results.some(x => !x)) { console.error(`${results.filter(x => !x).length} of ${results.length} failed`); process.exit(1); }
    console.log(`\nAll ${results.length} plain-words checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
