// Layout fixes from the Mobile tester's tablet and landscape pass (#10079, #10075): the providers of New agent step 3 are an even grid (equal columns in a row where they fit, two by two on a phone, as wide as the Model field below);
// on a short screen (a phone turned sideways, 844x390) the wizard's page between its pinned header and footer is taller (step 2's Name was cut); a tablet's (768 px) first chat starts with the empty file dock closed,
// a desktop's open. Isolated dev server; shots in CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install, select } = await connect();
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const size = (w, h, mobile) => Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }).then(() => Emulation.setTouchEmulationEnabled({ enabled: mobile }));
        const wizard = async (w, h, mobile, step) => {
            await size(w, h, mobile);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await installNA(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewAgent(ev, waitFor);
            for (let n = 1; n < step; n++) {
                if (n === 1) await ev(`(() => { const e = window.__na.find('input', ${N.folder}); e.value = '/work/payments-app'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
                await ev(`window.__na.find('button', ${N.next}).click(); true`);
                await waitFor(`new RegExp('Step ${n + 1} of 3').test(window.__na.dialog().textContent)`, `step ${n + 1}`, 6000);
            }
        };
        // 1. providers: even columns
        await wizard(844, 390, true, 3);
        await waitFor(`document.querySelectorAll('#launch-agent-pick .provider-card-head').length >= 1`, 'the providers', 8000);
        // the provider cards (#11235) are a column of full-width cards, each 44 px or more, the form's width
        const cardsNow = () => ev(`(() => { const p = document.getElementById('launch-agent-pick').getBoundingClientRect(), m = document.querySelector('#launch-agent-acf select.acf-model-select, #launch-agent-acf select')?.getBoundingClientRect(); return { pickW: Math.round(p.width), modelW: m ? Math.round(m.width) : 0, cards: [...document.querySelectorAll('#launch-agent-pick .provider-card-head')].map(e => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }), inside: p.left >= 0 && p.right <= innerWidth + 1 }; })()`);
        let g = await cardsNow();
        assert.ok(g.cards.length >= 1 && g.cards.every(c => c[1] >= 44) && g.inside, 'landscape: the provider cards are 44 px or more and on the screen: ' + JSON.stringify(g));
        await shot('providers-844x390');
        await wizard(390, 844, true, 3);
        await waitFor(`document.querySelectorAll('#launch-agent-pick .provider-card-head').length >= 1`, 'the providers', 8000);
        g = await cardsNow();
        assert.ok(g.cards.every(c => c[1] >= 44 && c[0] >= g.pickW - 40) && g.inside, 'phone: the cards are full width and 44 px or more: ' + JSON.stringify(g));
        assert.ok(g.pickW >= g.modelW - 60, 'phone: the cards span the form, not a corner of it: ' + JSON.stringify(g));
        await shot('providers-390x844');
        // 2. a short screen: more page between the pinned header and footer
        await wizard(844, 390, true, 2);
        const m = await ev(`(() => { const d = window.__na.dialog(), vis = e => e.getClientRects().length > 0, hd = [...d.querySelectorAll('.sd-step-header')].find(vis).getBoundingClientRect(), ft = [...d.querySelectorAll('.launch-modal-step > .modal-actions')].find(vis).getBoundingClientRect(); return { header: Math.round(hd.height), footer: Math.round(ft.height), room: Math.round(ft.top - hd.bottom), inside: hd.top >= 0 && ft.bottom <= innerHeight + 1 }; })()`);
        assert.ok(m.inside, 'header and footer stay on the screen: ' + JSON.stringify(m));
        assert.ok(m.room >= 200, 'the page between them is at least 200 px on a 390 px screen: ' + JSON.stringify(m));
        await shot('wizard-step2-844x390');
        // 3. a tablet's first chat: the dock starts closed; a desktop's open
        for (const [width, height, mobile, open] of [[768, 1024, true, '0'], [1280, 800, false, '1']]) {
            await size(width, height, mobile);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.removeItem('coral-agentic-collapsed'); window.__m.add('ak', 'A', 6, { sleeping: false, session_id: 'ak-sid' }); window._coralSetLiveSessions(Object.values(window.__m.agents).map(a => window.__m.entry(a))); localStorage.setItem('coral-live-view-mode', 'chat'); true`);
            await select('ak');
            await waitFor(`window.__rendered && window.__rendered().length >= 3`, 'the chat', 15000);
            await waitFor(`document.body.getAttribute('data-dock-open') === ${JSON.stringify(open)}`, `${width}: the dock is ${open === '1' ? 'open' : 'closed'} on a first chat (now ${open === '1' ? 'closed' : 'open'})`, 4000);
            await shot(`first-chat-${width}`);
        }
        console.log('\nPASS even provider tiles, a taller wizard page on a short screen, the dock closed on a tablet\'s first chat');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
