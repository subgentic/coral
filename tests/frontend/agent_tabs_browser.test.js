// #11709 (the operator, folder tabs per agent; the mockup approved as v3): New Agent's Agent step is a strip of tabs, one per agent this computer has, and the open tab's panel holds that agent's Model and Thinking.
// Thinking is one select that never wraps (not a strip of eight buttons), Model and Thinking are two aligned rows (the labels in one column, the controls the same width), Model is the agent's dropdown with its refresh and
// "Add a model..." where it has a list, a missing agent is one quiet line (the word, its name, Install) and not a card, and on a phone the strip scrolls with a chevron button that only scrolls. At 1280 and 360 px, light and dark.
const assert = require('node:assert/strict');
const { coralReady } = require('./helpers/wait');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const settle = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: the tabs redraw over a frame or two
    const stub = (missing, agyHasNoLevels) => ev(`(() => { const R = window.fetch;
        window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin);
            if (url.pathname === '/api/settings' && (!o.method || o.method === 'GET')) return R(u, o).then(async r => { const d = await r.json(); d.settings = { ...(d.settings || {}), default_model_claude: 'claude-big' }; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
            if (${JSON.stringify(!!agyHasNoLevels)} && url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'agy') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'agy', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'agy-big', display_name: 'agy Big' }], thinking: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            if (url.pathname.startsWith('/api/agents/models') && url.searchParams.get('type') === 'pi') return Promise.resolve(new Response(JSON.stringify({ agent_type: 'pi', fetched_at: '2026-10-25T00:00:00Z', refreshing: false, source: 'account', models: [{ value: 'pi-big', display_name: 'pi Big', efforts: ['off', 'minimal', 'low', 'medium'] }], thinking: ['off', 'minimal', 'low', 'medium'] }), { status: 200, headers: { 'content-type': 'application/json' } }));
            return R(u, o); };
        return true; })()`).then(() => require('./helpers/new_agent').stubCliChecks(ev, missing));
    const open = async (w, h, mobile, theme, missing, agyNoLevels, fontPx) => {
        await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); ${fontPx ? `document.documentElement.style.setProperty('font-size', '${fontPx}px', 'important');` : ''} true`);
        await stubModels(ev); await stub(missing, agyNoLevels);
        await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
        await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
        await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); document.getElementById('launch-agent-next').click(); return true; })()`);
        await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
        await settle(400);
    };

    const shot = async n => { if (!process.env.SHOT) return; require('fs').writeFileSync(`${process.env.SHOT}-${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 900, false], [360, 760, true]]) for (const theme of ['light', 'dark']) {
            const at = `${w} px ${theme}: `;
            await open(w, h, mobile, theme, ['opencode'], false);
            const G = '#launch-agent-pick';
            const geo = () => ev(`(() => { const g = document.querySelector('${G}'), r = e => e && e.getBoundingClientRect(), vis = e => e && e.getClientRects().length > 0;
                const tabs = [...g.querySelectorAll('.provider-tabs .provider-card-head')], on = g.querySelector('.provider-card-head.is-open'), body = g.querySelector('.provider-card-body:not([hidden])');
                const rows = [...body.querySelectorAll('.sv-row')].filter(vis), label = row => row.querySelector('label, .sv-label, .sv-row-label'), ctl = row => row.querySelector('select, input:not([type=radio]):not([type=checkbox])');
                const model = rows.find(x => x.dataset.key === 'model'), think = rows.find(x => x.dataset.key === 'thinking');
                const thinkSel = think && think.querySelector('select.acf-thinking'), seg = think && think.querySelector('.seg-group');
                const miss = g.querySelector('.provider-missing');
                return { tabs: tabs.map(t => t.querySelector('.provider-name').textContent), onName: on && on.querySelector('.provider-name').textContent, tabsTop: tabs.map(t => Math.round(r(t).top)), tabH: Math.min(...tabs.map(t => Math.round(r(t).height))), joined: on && Math.abs(r(on).bottom - r(body.parentElement).top) <= 2,
                    thinkingSelect: !!thinkSel && vis(thinkSel), segShown: !!seg && vis(seg), thinkH: think && Math.round(r(think).height), modelH: model && Math.round(r(model).height),
                    modelCtl: model && vis(ctl(model)) ? [Math.round(r(ctl(model)).left), Math.round(r(ctl(model)).width)] : null, thinkCtl: think && thinkSel ? [Math.round(r(thinkSel).left), Math.round(r(thinkSel).width)] : null,
                    missingLines: miss ? Math.round(r(miss).height) : 0, missingCards: g.querySelectorAll('.provider-missing .provider-card').length, sideways: document.documentElement.scrollWidth > innerWidth + 1,
                    chev: (() => { const c = g.querySelector('.provider-strip-edge'); return c ? { shown: !c.hidden && vis(c), w: Math.round(r(c).width), h: Math.round(r(c).height) } : null; })() }; })()`);
            let d = await geo();
            assert.ok(d.tabs.length >= 3 && d.onName, at + 'one tab per agent this computer has: ' + JSON.stringify(d));
            assert.ok(new Set(d.tabsTop).size === 1 && d.tabH >= 40 && d.joined, at + 'the tabs are one row, 40 px or more, and the open one joins its panel: ' + JSON.stringify(d));
            assert.ok(d.missingCards === 1 && d.missingLines <= 56, at + 'a missing agent is one quiet line, not a card: ' + JSON.stringify({ c: d.missingCards, h: d.missingLines }));
            // every tab in turn: Thinking is a select, never a strip of buttons; Model and Thinking are aligned
            for (const type of ['claude', 'pi']) {
                await ev(`document.querySelector('${G} input[value="${type}"]').click(); true`); await settle(500);
                d = await geo();
                assert.ok(d.thinkingSelect && !d.segShown, at + `${type}: Thinking is one select and no strip of buttons: ` + JSON.stringify(d));
                // #10837: one line says what a level costs, and the refresh is named on sight where there is room (a desktop with a mouse), icon only on a phone
                const w2 = await ev(`(() => { const g = document.querySelector('${G}'), hint = g.querySelector('.provider-card-body:not([hidden]) .provider-think-hint'), t = g.querySelector('.provider-card-body:not([hidden]) .acf-model-refresh-text'), vis = e => !!e && e.getClientRects().length > 0; return { hint: hint ? hint.textContent : null, hintShown: vis(hint), hintH: hint ? Math.round(hint.getBoundingClientRect().height + 4) : 0, label: t ? t.textContent : null, labelShown: vis(t) }; })()`);
                assert.equal(w2.hint, 'More thinking is slower and costs more. Default lets the agent choose.', at + `${type}: one line on what Thinking costs: ` + JSON.stringify(w2));
                assert.ok(w2.hintShown, at + `${type}: the line is on screen`);
                assert.equal(w2.labelShown, !mobile, at + `${type}: the refresh says "Refresh models" on a desktop and is the icon alone on a phone: ` + JSON.stringify(w2));
                assert.ok(d.thinkH === d.modelH || Math.abs(d.thinkH - w2.hintH - d.modelH) <= 48, at + `${type}: Model and Thinking are rows of the same kind: ` + JSON.stringify([d.modelH, d.thinkH]));
                assert.ok(d.modelCtl && d.thinkCtl && Math.abs(d.modelCtl[0] - d.thinkCtl[0]) <= 1, at + `${type}: the labels are one column, so the controls start at the same x: ` + JSON.stringify([d.modelCtl, d.thinkCtl]));
                assert.ok(!d.sideways, at + `${type}: nothing scrolls sideways`);
            }
            // Claude has a model list: the dropdown, its refresh and "Add a model..."; Pi keeps the text field it had
            await ev(`document.querySelector('${G} input[value="claude"]').click(); true`); await settle(400);
            const claude = await ev(`(() => { const b = document.querySelector('${G} .provider-card-body:not([hidden])'), s = b.querySelector('select.acf-model-select'); return { select: !!s && s.getClientRects().length > 0, add: s ? [...s.options].some(o => /Add a model/.test(o.textContent)) : false, refresh: !!b.querySelector('.acf-model-refresh') }; })()`);
            assert.ok(claude.select && claude.add && claude.refresh, at + 'Claude: the model dropdown, its refresh, and "Add a model...": ' + JSON.stringify(claude));
            await shot(`${w}-${theme}`);
            if (mobile) {
                const c = (await geo()).chev;
                assert.ok(c && c.shown && c.w >= 44 && c.h >= 44, at + 'the strip scrolls and its chevron is a 44 px button: ' + JSON.stringify(c));
                const before = await ev(`document.querySelector('${G} .provider-tabs').scrollLeft`);
                await ev(`document.querySelector('${G} .provider-strip-edge').click(); true`); await settle(600);
                const after = await ev(`({ left: document.querySelector('${G} .provider-tabs').scrollLeft, on: document.querySelector('${G} .provider-card-head.is-open .provider-name').textContent })`);
                assert.ok(after.left > before && after.on === 'Claude', at + 'a tap on the chevron scrolls and chooses nothing: ' + JSON.stringify({ before, after }));
            }
        }
        console.log('\nPASS the Agent step as folder tabs');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
