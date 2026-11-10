// A sleeping team (walk 16 H5 and M10, walk 17 L17, #15286): the Time on task clock of a sleeping agent shows no running time (a dash, not a "5 m" that keeps counting), and a danger item of a menu
// (Kill session, Reset team, Kill all) is the menu's own colour at rest and red only under the pointer. The isolated dev server; the module is imported and the rule read from the page's own sheets.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
        const r = await ev(`import(${S} + 'team_agents_page.js').then(m => { const since = new Date(Date.now() - 5 * 60000).toISOString(); return { awake: m.onTaskWords({ task_since: since, availability: 'task_idle' }), asleep: m.onTaskWords({ task_since: since, availability: 'sleeping' }) }; })`);
        assert.equal(r.awake, '5 m', 'an awake agent shows its time on the task: ' + JSON.stringify(r));
        assert.equal(r.asleep, '', 'a sleeping agent shows no running clock: ' + JSON.stringify(r));
        const c = await ev(`(() => { const m = document.createElement('div'); m.className = 'menu'; m.innerHTML = '<button class="menu-item">Sleep team</button><button class="menu-item menu-item-danger">Kill all</button>'; document.body.append(m);
            const a = getComputedStyle(m.children[0]).color, b = getComputedStyle(m.children[1]).color; m.remove();
            const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } }).flatMap(x => x.cssRules ? [...x.cssRules, x] : [x]).filter(x => x.selectorText && /\\.menu-item-danger/.test(x.selectorText));
            return { a, b, hover: rules.some(x => /:hover/.test(x.selectorText) && /error-text/.test(x.style.color || x.cssText)), focus: rules.some(x => /:focus-visible/.test(x.selectorText) && /error-text/.test(x.style.color || x.cssText)) }; })()`);
        assert.equal(c.a, c.b, 'a danger item is the menu\'s own colour at rest: ' + JSON.stringify(c));
        assert.ok(c.hover, 'and it turns red under the pointer: ' + JSON.stringify(c));
        assert.ok(c.focus, 'and under the keyboard focus, so a keyboard user sees the danger too: ' + JSON.stringify(c));
        console.log('team_asleep_clock: ok');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
