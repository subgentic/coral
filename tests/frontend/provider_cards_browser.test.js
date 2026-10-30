// The provider cards of New Agent's Agent step (#11235, the Operator's pick, Option B), at 1440 and 390 px (and 320), in the light and dark themes:
//  - each installed provider is a radio card saying "Installed · default <model>" (the saved default model when there is one); the open card, and only it, holds its Model (with its refresh) and Thinking;
//  - Thinking offers only the levels that provider has, or says "<Provider> has no thinking levels, so there is nothing to set.";
//  - a provider that is not installed is under "Not installed" with an Install link and no radio;
//  - nothing says "optional" in the step; the focus ring is for the keyboard (:focus-visible), so a card chosen by the mouse shows only the open state;
//  - the keyboard: the arrow keys move between the cards, Tab goes into the open card's controls;
//  - a phone: the Thinking strip wraps inside the card (a select under 360 px), every target is 44 px, and Launch stays on the screen.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server, the CLI checks and the model lists stood in.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, N, stubModels } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const problems = [];
    const check = (ok, what) => { if (!ok) problems.push(what); };
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the card redraws over a frame or two after a key or a click
    const press = async (key, vk) => { await Input.dispatchKeyEvent({ type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk }); await Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }); await settle(300); };
    // The page's own fetches, stood in: Claude, Codex and Pi installed, Antigravity not; Claude's saved default model; Antigravity (when it is installed) has no thinking levels.
    const stub = (missing, agyHasNoLevels) => ev(`(() => { const R = window.fetch;
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/settings' && (!o.method || o.method === 'GET')) return R(u, o).then(async r => { const d = await r.json(); d.settings = { ...(d.settings || {}), default_model_claude: 'claude-big' }; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (${JSON.stringify(!!agyHasNoLevels)} && url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'agy') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'agy', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'agy-big', display_name: 'agy Big' }], thinking: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); };
        return true; })()`).then(() => require('./helpers/new_agent').stubCliChecks(ev, missing));
    const open = async (w, h, mobile, theme, missing, agyNoLevels) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
        await stubModels(ev); await stub(missing, agyNoLevels);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };
    const READ = `(() => { const g = document.getElementById('launch-agent-pick'); const vis = e => e.getClientRects().length > 0;
        const cards = [...g.querySelectorAll('.provider-card:not(.is-missing)')].map(c => ({ type: c.dataset.type, name: c.querySelector('.provider-name').textContent, status: c.querySelector('.provider-status').textContent, open: c.classList.contains('is-open'), hasModel: !!c.querySelector('.acf-model-select') && vis(c.querySelector('.acf-model-select')), hasRefresh: !!c.querySelector('.acf-model-refresh'), hasThinking: !!c.querySelector('.sv-row[data-key="thinking"]') && vis(c.querySelector('.sv-row[data-key="thinking"]')), levels: [...c.querySelectorAll('.seg-btn')].filter(vis).map(b => b.textContent.trim()), none: (c.querySelector('.provider-no-thinking') && !c.querySelector('.provider-no-thinking').hidden) ? c.querySelector('.provider-no-thinking').textContent : null, radio: !!c.querySelector('input[type=radio]') }));
        const missing = [...g.querySelectorAll('.provider-missing .provider-card')].map(c => ({ name: c.querySelector('.provider-name').textContent, radio: !!c.querySelector('input'), link: (c.querySelector('a') || {}).textContent || null }));
        const optional = [...document.querySelectorAll('#launch-step-agent [data-section="agent"] .sv-optional, #sd1-pane-agent .sv-optional, #sd1-pane-agent .launch-optional')].filter(vis).length;
        return { cards, missing, optional, heading: (g.querySelector('.provider-missing-title') || {}).textContent || null }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light']]) {
            const tag = `${w}px ${theme}`;
            await open(w, h, mobile, theme, ['agy'], false);
            let d = await ev(READ);
            check(JSON.stringify(d.cards.map(c => c.name)) === JSON.stringify(['Claude', 'Codex', 'Pi']), `${tag}: the installed providers are the cards: ${JSON.stringify(d.cards.map(c => c.name))}`);
            check(d.cards.every(c => c.radio), `${tag}: each card has a radio`);
            check(d.cards.every(c => /^Installed · default /.test(c.status)), `${tag}: each says Installed · default <model>: ${JSON.stringify(d.cards.map(c => c.status))}`);
            check(/default claude Big$/.test(d.cards[0].status), `${tag}: Claude says its saved default model: ${d.cards[0].status}`);
            check(d.cards.filter(c => c.open).length === 1 && d.cards[0].open, `${tag}: one card is open, Claude: ${JSON.stringify(d.cards.map(c => c.open))}`);
            check(d.cards[0].hasModel && d.cards[0].hasRefresh && d.cards[0].hasThinking, `${tag}: the open card holds Model, its refresh and Thinking: ${JSON.stringify(d.cards[0])}`);
            check(JSON.stringify(d.cards[0].levels) === JSON.stringify(['Default', 'Low', 'Medium', 'High']), `${tag}: Claude's Thinking offers its levels: ${JSON.stringify(d.cards[0].levels)}`);
            check(d.cards.slice(1).every(c => !c.hasModel && !c.hasThinking), `${tag}: a closed card holds no Model or Thinking`);
            check(d.heading === 'Not installed' && d.missing.length === 1 && d.missing[0].name === 'Antigravity' && !d.missing[0].radio && /^Install Antigravity$/.test(d.missing[0].link), `${tag}: Antigravity is under Not installed with an Install link and no radio: ${JSON.stringify([d.heading, d.missing])}`);
            check(d.optional === 0, `${tag}: nothing in the step says optional (${d.optional})`);

            // the mouse: a card chosen by a click shows the open state, not a focus ring; the keyboard shows the ring
            const headBox = type => ev(`(() => { const r = document.querySelector('#launch-agent-pick .provider-card[data-type="${type}"] .provider-card-head').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`);
            const b = await headBox('codex');
            await Input.dispatchMouseEvent({ type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 }); await Input.dispatchMouseEvent({ type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 }); await settle(400);
            const ring = type => ev(`(() => { const h = document.querySelector('#launch-agent-pick .provider-card[data-type="${type}"] .provider-card-head'); const cs = getComputedStyle(h); return { outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, focusVisible: !!h.querySelector('input:focus-visible') }; })()`);
            d = await ev(READ);
            check(d.cards.find(c => c.open)?.type === 'codex', `${tag}: a click opens Codex: ${JSON.stringify(d.cards.map(c => [c.type, c.open]))}`);
            const r1 = await ring('codex'), r2 = await ring('claude');
            check(!r1.outline && !r2.outline, `${tag}: after a click no card shows a focus ring (only the open state): ${JSON.stringify([r1, r2])}`);
            check(d.cards.find(c => c.type === 'codex').levels.length > 0 && d.cards.find(c => c.type === 'claude').levels.length === 0, `${tag}: Thinking moved with the open card`);
            // the keyboard: Down moves to the next card and shows the ring on it; Tab goes into the open card's controls
            await press('ArrowDown', 40);
            d = await ev(READ);
            check(d.cards.find(c => c.open)?.type === 'pi', `${tag}: the arrow key moves to the next card (Pi): ${JSON.stringify(d.cards.map(c => [c.type, c.open]))}`);
            const r3 = await ring('pi');
            check(r3.outline && r3.focusVisible, `${tag}: the keyboard shows the ring on the card it is on: ${JSON.stringify(r3)}`);
            await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await settle(200);
            const inCard = await ev(`(() => { const a = document.activeElement, c = a && a.closest('.provider-card'); return { type: c ? c.dataset.type : null, cls: a ? a.className.toString().slice(0, 40) : '' }; })()`);
            check(inCard.type === 'pi', `${tag}: Tab goes into the open card's controls: ${JSON.stringify(inCard)}`);

            if (mobile) {
                // a phone: the open card's controls and Launch
                await ev(`document.querySelector('#launch-agent-pick input[value="claude"]').click(); true`); await settle(400);
                const m = await ev(`(() => { const vis = e => e.getClientRects().length > 0, box = e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
                    const open = document.querySelector('#launch-agent-pick .provider-card.is-open'); const pane = document.getElementById('sd1-pane-agent'); const launch = document.getElementById('launch-agent-go');
                    return { heads: [...document.querySelectorAll('#launch-agent-pick .provider-card-head')].map(box), refresh: box(open.querySelector('.acf-model-refresh')), seg: [...open.querySelectorAll('.seg-btn')].filter(vis).map(box), select: box(open.querySelector('.acf-model-select')), launchBottom: Math.round(launch.getBoundingClientRect().bottom), launchShown: vis(launch), vh: innerHeight, sideways: pane.scrollWidth > pane.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1, install: [...document.querySelectorAll('#launch-agent-pick .provider-install')].map(box) }; })()`);
                check(m.heads.every(z => z[1] >= 44) && m.refresh[0] >= 44 && m.refresh[1] >= 44 && m.seg.every(z => z[1] >= 44) && m.select[1] >= 44 && m.install.every(z => z[1] >= 44), `${tag}: every target is 44 px: ${JSON.stringify(m)}`);
                check(m.launchShown && m.launchBottom <= m.vh, `${tag}: Launch stays on the screen (bottom ${m.launchBottom} of ${m.vh})`);
                check(!m.sideways, `${tag}: nothing scrolls sideways (the Thinking strip wraps)`);
            }
        }
        // a provider with no thinking levels says so, and a narrow phone has the select for Thinking
        await open(1440, 900, false, 'light', [], true);
        await ev(`document.querySelector('#launch-agent-pick input[value="agy"]').click(); true`); await settle(500);
        let d = await ev(READ);
        const agy = d.cards.find(c => c.type === 'agy');
        check(agy && agy.open && agy.hasModel && !agy.hasThinking && agy.none === 'Antigravity has no thinking levels, so there is nothing to set.', `no levels: Antigravity says it has none and shows no Thinking row: ${JSON.stringify(agy)}`);
        check(d.cards.filter(c => c.type !== 'agy').every(c => c.none === null), 'no levels: the sentence is in the open card only');
        await open(320, 700, true, 'dark', [], false);
        const narrow = await ev(`(() => { const open = document.querySelector('#launch-agent-pick .provider-card.is-open'); const vis = e => e && e.getClientRects().length > 0; const sel = open.querySelector('select.acf-thinking'); return { select: vis(sel), segs: [...open.querySelectorAll('.seg-group')].some(vis), sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
        check(narrow.select && !narrow.segs && !narrow.sideways, `320 px: Thinking is a select and nothing scrolls sideways: ${JSON.stringify(narrow)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the provider cards:\n  ' + problems.slice(0, 30).join('\n  '));
    console.log('PASS provider cards: installed providers as radio cards with their own Model and Thinking, Not installed with a link and no radio, the keyboard, a phone');
})().catch(e => { console.error(e); process.exit(1); });
