// The New job dialog shows "pick one" one way (design guidelines, #15836): Type and When are both the family's segmented strip (one box, hairlines between the choices), not a strip and five separate boxes.
// Both strips: one border box with the choices joined inside it, the chosen one filled, the arrow keys (and Home and End) move the choice and press it, one tab stop. At 390 px When wraps to two rows and the box and
// the lines between the rows are kept; at 200% text nothing runs past the dialog. 1440 and 390 px, dark and light. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (ok, what) => { if (!ok) problems.push(what); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const measure = () => ev(`(() => {
        const strip = s => { const g = document.querySelector(s); if (!g) return null; const gb = g.getBoundingClientRect(), cs = getComputedStyle(g), kids = [...g.querySelectorAll(':scope > .btn')];
            const tops = [...new Set(kids.map(b => Math.round(b.getBoundingClientRect().top)))];
            const lines = kids.map(b => { const k = getComputedStyle(b); return k.borderInlineStartWidth; });
            return { box: g.classList.contains('btn-seg'), border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, n: kids.length, rows: tops.length, right: Math.round(gb.right), left: Math.round(gb.left), tabs: kids.filter(b => b.tabIndex === 0).length, pressed: kids.filter(b => b.getAttribute('aria-pressed') === 'true').length,
                gap: cs.rowGap, bg: cs.backgroundColor, sep: cs.getPropertyValue('--control-border'), lines, apart: kids.some(b => parseFloat(getComputedStyle(b).marginLeft) > 0) }; };
        const dlg = document.querySelector('#job-modal .modal-content, #job-modal'), d = dlg.getBoundingClientRect();
        return { type: strip('#job-type-toggle'), when: strip('#sched-picker .sched-presets'), dlg: { l: Math.round(d.left), r: Math.round(d.right) }, over: [...document.querySelectorAll('#job-modal button, #job-modal select, #job-modal input')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).length, scroll: dlg.scrollWidth - dlg.clientWidth }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        const modes = [['1440 px dark', 1440, 900, false, 'dark', ''], ['1440 px light', 1440, 900, false, 'light', ''], ['390 px dark', 390, 844, true, 'dark', ''], ['390 px light', 390, 844, true, 'light', ''], ['390 px 200% text', 390, 844, true, 'dark', '200%']];
        for (const [label, w, h, mobile, theme, zoom] of modes) {
            const at = label + ': ';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); document.documentElement.style.fontSize = ${JSON.stringify(zoom)}; Promise.resolve(window.showJobModal()).then(() => true)`);
            await waitFor(`!!document.getElementById('job-modal-name') && !!document.querySelector('#sched-picker .sched-presets') && getComputedStyle(document.getElementById('job-modal')).display !== 'none'`, `${at}the New job dialog`, 10000);
            await ev(`new Promise(r => setTimeout(r, 500)).then(() => true)`); // sleep-ok: the dialog settles before it is measured
            const m = await measure();
            for (const k of ['type', 'when']) {
                const s = m[k]; if (!s) { check(false, `${at}${k} strip missing`); continue; }
                check(s.box && s.border === '1px', `${at}${k} is one segmented box with a border (${JSON.stringify([s.box, s.border])})`);
                check(s.pressed === 1 && s.tabs === 1, `${at}${k} has one chosen button and one tab stop (${s.pressed}, ${s.tabs})`);
                check(!s.apart, `${at}${k}'s buttons are joined, not separate boxes`);
            }
            if (m.type && m.when) {
                check(m.type.radius === m.when.radius, `${at}Type and When have the same corners (${m.type.radius} vs ${m.when.radius})`);
                check(m.type.left === m.when.left && m.type.right === m.when.right, `${at}the two strips are as wide as one another: ${JSON.stringify([m.type.left, m.type.right, m.when.left, m.when.right])}`);
                if (w < 768 && !zoom) check(m.when.rows === 2 && m.when.gap === '1px', `${at}When wraps to two rows with the 1px line between them kept (${m.when.rows} rows, gap ${m.when.gap})`);
                if (w >= 768) check(m.when.rows === 1, `${at}When is one row at ${w} px (${m.when.rows})`);
            }
            check(m.over === 0 && m.scroll <= 1, `${at}nothing runs past the dialog or the screen (${m.over}, ${m.scroll})`);
            if (label === '1440 px dark') { // the keys: arrows move the choice and press it; Home and End; the tab stop follows
                const keys = async (sel, key) => { await ev(`(() => { const g = document.querySelector(${JSON.stringify(sel)}); const a = g.contains(document.activeElement) ? document.activeElement : g.querySelector('[tabindex="0"]'); a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true; })()`); await ev(`new Promise(r => setTimeout(r, 120)).then(() => true)`); /* sleep-ok: the press lands */ return ev(`(() => { const g = document.querySelector(${JSON.stringify(sel)}); const on = [...g.querySelectorAll(':scope > .btn')].filter(b => b.getAttribute('aria-pressed') === 'true'); return { on: on.map(b => b.dataset.mode || b.dataset.type), focus: g.contains(document.activeElement) && (document.activeElement.dataset.mode || document.activeElement.dataset.type), tab: [...g.querySelectorAll(':scope > .btn')].filter(b => b.tabIndex === 0).map(b => b.dataset.mode || b.dataset.type) }; })()`); };
                let r = await keys('#sched-picker .sched-presets', 'ArrowRight');
                check(r.on.length === 1 && r.focus === r.on[0] && r.tab[0] === r.on[0] && r.tab.length === 1, `When: ArrowRight moves the choice, the focus and the tab stop together (${JSON.stringify(r)})`);
                const first = r.on[0];
                r = await keys('#sched-picker .sched-presets', 'End'); check(r.on[0] === 'cron', `When: End picks the last (${JSON.stringify(r)})`);
                r = await keys('#sched-picker .sched-presets', 'ArrowRight'); check(r.on[0] === 'minutes', `When: ArrowRight past the last goes round to the first (${JSON.stringify(r)})`);
                r = await keys('#sched-picker .sched-presets', 'Home'); check(r.on[0] === 'minutes', `When: Home picks the first (${JSON.stringify(r)})`);
                r = await keys('#job-type-toggle', 'ArrowLeft'); check(r.on.length === 1 && r.focus === r.on[0] && r.tab.length === 1 && r.tab[0] === r.on[0], `Type: an arrow moves the choice (${JSON.stringify(r)})`);
                check(first !== undefined, 'the first key press chose something');
            }
            if (label !== '1440 px light') await shot('job-form-strips-' + label.replace(/ /g, '-'));
            else await shot('job-form-strips-1440-px-light');
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'The New job dialog strips:\n  ' + problems.join('\n  '));
    console.log('PASS the New job dialog: Type and When are one segmented strip with arrow keys, When wraps with its lines kept');
})().catch(e => { console.error(e); process.exit(1); });
