// The provider is a segmented strip (#15887, LA3 of the Settings / New agent review, guideline 4.7), at 1440 and 390 px, dark and light, and at 200% text:
//  - one radiogroup named Provider with one segment per installed provider, in ONE bordered box (the strip), the chosen one filled and aria-checked; nothing scrolls sideways and every provider is on sight;
//  - what this computer lacks is not told in the dialog: no "Not installed or not used" list, no "Why?" fold, no install steps; ONE link, "Set up another provider", opens Settings;
//  - a segment is 36 px on a computer and 44 on a phone, no text in the group is under 12 px;
//  - the arrow keys move between the segments and change the form's one provider select.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server, the CLI checks and the model lists stood in.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
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
    const stub = (missing, agyHasNoLevels, refused = []) => ev(`(() => { const R = window.fetch;
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/settings' && (!o.method || o.method === 'GET')) return R(u, o).then(async r => { const d = await r.json(); d.settings = { ...(d.settings || {}), default_model_claude: 'claude-big' }; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (${JSON.stringify(!!agyHasNoLevels)} && url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'agy') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'agy', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'agy-big', display_name: 'agy Big' }], thinking: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            if (url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'pi') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'pi', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'pi-big', display_name: 'pi Big', efforts: ['off', 'minimal', 'low', 'medium'] }], thinking: ['off', 'minimal', 'low', 'medium'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); };
        return true; })()`).then(() => require('./helpers/new_agent').stubCliChecks(ev, missing, [], refused));
    const open = async (w, h, mobile, theme, missing, agyNoLevels, fontPx, refused = []) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} true`);
        await stubModels(ev); await stub(missing, agyNoLevels, refused);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } window._launchStage('agent'); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };
    const READ = `(() => { const g = document.getElementById('launch-agent-pick'), vis = e => e.getClientRects().length > 0;
        const strip = g.querySelector('.provider-strip'), segs = strip ? [...strip.querySelectorAll('.provider-card-head')] : [];
        const box = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
        const small = [...g.querySelectorAll('.provider-strip *, .provider-setup')].filter(e => vis(e) && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 12).map(e => e.className + ':' + e.textContent.trim().slice(0, 20));
        const link = [...g.querySelectorAll('button, a')].find(b => /Set up another provider/.test(b.textContent));
        return { label: g.getAttribute('role') + ':' + (g.getAttribute('aria-label') || (document.getElementById(g.getAttribute('aria-labelledby')) || {}).textContent), names: segs.map(s => s.querySelector('.provider-name').textContent.trim()), checked: segs.filter(s => s.querySelector('input').checked).map(s => s.querySelector('input').value), selectValue: document.querySelector('#launch-step-agent .acf-agent-type').value,
            segBoxes: segs.map(box), strip: strip && box(strip), stripBorder: strip && parseFloat(getComputedStyle(strip).borderTopWidth), stripSideways: strip ? strip.scrollWidth > strip.clientWidth + 1 : null, pageSideways: document.documentElement.scrollWidth > innerWidth + 1,
            missingList: !!g.querySelector('.provider-missing, .provider-list'), why: !!g.querySelector('details, .provider-why'), words: /Not installed or not used|Why\?|Install /.test(g.textContent), small, link: link ? { text: link.textContent.trim(), h: Math.round(link.getBoundingClientRect().height) } : null, fill: segs.map(s => getComputedStyle(s).backgroundColor) }; })()`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile, theme, fontPx] of [[1440, 900, false, 'dark'], [1440, 900, false, 'light'], [390, 844, true, 'dark'], [390, 844, true, 'light'], [1440, 900, false, 'light', 32], [390, 844, true, 'dark', 32]]) {
            const tag = `${w}px ${theme}${fontPx ? ' 200%' : ''}`;
            await open(w, h, mobile, theme, ['agy'], false, fontPx);
            const d = await ev(READ);
            check(d.label === 'radiogroup:Provider', `${tag}: the strip is a radiogroup named Provider: ${d.label}`);
            check(JSON.stringify(d.names) === JSON.stringify(['Claude', 'Codex', 'Pi', 'OpenCode', 'Hermes']), `${tag}: one segment per installed provider: ${JSON.stringify(d.names)}`);
            check(JSON.stringify(d.checked) === '["claude"]' && d.selectValue === 'claude', `${tag}: Claude is chosen, in the radio and in the form's select: ${JSON.stringify([d.checked, d.selectValue])}`);
            check(d.strip && d.stripBorder >= 1 && d.segBoxes.every(b => b.x >= d.strip.x - 1 && b.x + b.w <= d.strip.x + d.strip.w + 1 && b.y >= d.strip.y - 1 && b.y + b.h <= d.strip.y + d.strip.h + 1), `${tag}: every segment sits inside the one bordered strip: ${JSON.stringify([d.strip, d.segBoxes])}`);
            check(d.stripSideways === false && !d.pageSideways, `${tag}: nothing scrolls sideways: ${JSON.stringify([d.stripSideways, d.pageSideways])}`);
            check(d.segBoxes.every(b => b.h >= (mobile ? 44 : 36)), `${tag}: a segment is ${mobile ? 44 : 36} px or more: ${JSON.stringify(d.segBoxes.map(b => b.h))}`);
            check(!d.missingList && !d.why && !d.words, `${tag}: no missing list, no Why? fold, no install steps in the dialog: ${JSON.stringify([d.missingList, d.why, d.words])}`);
            check(d.link && d.link.text === 'Set up another provider' && d.link.h >= (mobile ? 44 : 36), `${tag}: one link, Set up another provider: ${JSON.stringify(d.link)}`);
            check(d.small.length === 0, `${tag}: no text in the strip or the link under 12 px: ${JSON.stringify(d.small)}`);
            check(new Set(d.fill).size === 2, `${tag}: the chosen segment alone is filled: ${JSON.stringify(d.fill)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { const s = await Page.captureScreenshot({ format: 'png' }); require('fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/la3_${tag.replace(/[ %]/g, '_')}.png`, Buffer.from(s.data, 'base64')); }
        }
        // the link opens Settings
        await open(1440, 900, false, 'dark', ['agy'], false);
        await ev(`window.__settingsOpened = []; window.showSettingsModal = (...a) => { window.__settingsOpened.push(a); }; true`);
        await ev(`[...document.querySelectorAll('#launch-agent-pick button')].find(b => /Set up another provider/.test(b.textContent))?.click(); true`);
        check(JSON.stringify(await ev(`window.__settingsOpened`)) === '[["agents"]]', 'the link opens Settings');
        // the keyboard
        await ev(`document.querySelector('#launch-agent-pick input[value="claude"]').focus()`);
        await press('ArrowRight', 39);
        const k = await ev(`({ v: document.querySelector('#launch-step-agent .acf-agent-type').value, c: [...document.querySelectorAll('#launch-agent-pick input:checked')].map(i => i.value), open: [...document.querySelectorAll('#launch-agent-pick .provider-card-body:not([hidden])')].map(b => b.dataset.type) })`);
        check(k.v === 'codex' && k.c.join() === 'codex' && k.open.join() === 'codex', `ArrowRight chooses Codex everywhere: ${JSON.stringify(k)}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the provider strip:\n  ' + problems.slice(0, 30).join('\n  '));
    console.log('PASS provider strip: one segmented radiogroup of the installed providers, no troubleshooting in the dialog, one link to Settings, 1440 and 390, dark and light, 200% text, the keyboard');
})().catch(e => { console.error(e); process.exit(1); });
