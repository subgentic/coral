// The light theme's cards and table boxes were the page's own greys (#10694, the Desktop tester's measure on #10307): the Analytics tiles and Cumulative spend are rgb(236,237,240) on the rgb(244,245,247) page (1.07:1) and the
// table boxes of Docs and Automations have the page's own fill (1.00:1), so the screen read as three greys within 7%. White cannot reach 1.15:1 against that page (it is 1.09), so a card is a white surface with a soft shadow
// and an edge that is at least 1.15:1 on the page. Dark is unchanged. Probes the real stylesheet through each card and table class, in both themes, at 1280 px. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { setTheme } = require('./helpers/contrast');
const BASE = require('./test_base').BASE;

const CLASSES = ['cost-card', 'cost-chart-container', 'spend-box', 'eff-card', 'eff-panel', 'dt-box'];

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'liveListLoaded', 'settings')`);
        await ev(`import((window.__coralStatic || '/static/') + 'lazy_styles.js').then(m => m.loadStyles('cost_dashboard.css')).then(() => true)`); // the Analytics cards' rules arrive with the Analytics page since #10706, not with the start's stylesheet
        await ev(`(() => { const host = document.createElement('div'); host.id = 'surface-probe'; host.style.cssText = 'position:fixed;left:0;top:0;width:600px;padding:8px;z-index:1;background:var(--bg-primary)'; host.innerHTML = ${JSON.stringify(CLASSES.map(c => `<div class="${c}" data-probe="${c}" style="margin:6px 0;min-height:20px">x</div>`).join(''))}; document.body.append(host); return true; })()`);
        const read = () => ev(`(() => { const lum = c => { const m = c.match(/[\\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
            const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
            const page = getComputedStyle(document.getElementById('surface-probe')).backgroundColor;
            return Object.fromEntries(${JSON.stringify(CLASSES)}.map(c => { const cs = getComputedStyle(document.querySelector('[data-probe="' + c + '"]')); return [c, { fill: cs.backgroundColor, fillRatio: ratio(cs.backgroundColor, page), lighter: lum(cs.backgroundColor) > lum(page), shadow: cs.boxShadow, edge: ratio(cs.borderTopColor, page), edgeW: cs.borderTopWidth }]; })); })()`);
        await setTheme(ev, 'light');
        const light = await read();
        for (const c of CLASSES) {
            const r = light[c];
            if (!r.lighter) problems.push(`light: .${c} is not lighter than the page it sits on (fill ${r.fill}, ${r.fillRatio.toFixed(2)}:1)`);
            if (r.shadow === 'none') problems.push(`light: .${c} has no soft shadow`);
            if (r.edge < 1.15 || r.edgeW === '0px') problems.push(`light: .${c}'s edge is ${r.edge.toFixed(2)}:1 on the page (width ${r.edgeW}), under 1.15:1`);
        }
        await setTheme(ev, 'dark');
        const dark = await read();
        for (const c of CLASSES) if (dark[c].shadow !== 'none') problems.push(`dark: .${c} grew a shadow (${dark[c].shadow}); dark is unchanged`);
        if (dark['cost-card'].fill === 'rgb(255, 255, 255)') problems.push('dark: the card fill went white');
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'light cards and table boxes:\n  ' + problems.join('\n  '));
    console.log('PASS light cards and table boxes are white with a shadow and an edge; dark is unchanged');
})().catch(e => { console.error(e); process.exit(1); });
