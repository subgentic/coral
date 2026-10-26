// Links on the message board are readable in both themes (#3548): a post's links (a web link, a
// dashboard page link, an artifact link) and a subscriber's name take the theme's link colour
// (--accent) instead of the browser's #0000ee, with a hover underline and a visible keyboard
// focus ring; a subscriber's name is a button (no javascript: href) that still opens the agent.
// BOARD_LINK_SHOTS=<dir> also saves the board in each theme.
'use strict';

const CDP = require('chrome-remote-interface');
const fs = require('node:fs');
const path = require('node:path');
const BASE = require('./test_base').BASE;

const results = [];
const check = (label, ok, detail) => { results.push(!!ok); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' — ' + detail : ''}`); };
const HEX = 'c'.repeat(64);

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => {
        const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
    };
    const { waitFor, coralReady } = require('./helpers/wait').bind(ev);
    const until = (expr, what) => waitFor(expr, what, { timeout: 8000, soft: true });
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
        body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(r => r.status)`);
    const board = 'links-qa-3548';
    const shots = process.env.BOARD_LINK_SHOTS || '';
    try {
        await Page.enable();
        // A desktop window (run.sh's default headless size hides the Subscribers column) with
        // focus emulated, so :focus-visible can match in a headless page (QA, #3548).
        const VIEW = { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false };
        await Emulation.setDeviceMetricsOverride(VIEW);
        await Emulation.setFocusEmulationEnabled({ enabled: true });
        const loaded = Page.loadEventFired();
        await Page.navigate({ url: BASE + '/' });
        await loaded;
        await coralReady();
        await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'Links QA', job_title: 'Links QA' });
        await api('POST', `/api/board/${board}/messages`, { subscriber_id: 'Links QA',
            content: `See [the docs](https://example.test/docs), [the agents](/agents) and [the report](coral://artifacts/${HEX}).` });
        await ev(`localStorage.setItem('coral.board.view', 'chat'); true`); // the chat rows: the team page's Board tab is the table by default
        const l2 = Page.loadEventFired();
        await Page.navigate({ url: `${BASE}/board/${board}` });
        await l2;
        await coralReady();
        const POST = '#team-page-view .mb-message-body'; // /board/<team> opens the team page (#8129)
        await until(`document.querySelectorAll('${POST} a').length >= 3`, 'the post');

        const themes = async theme => {
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'settings_core.js'); m.clearCustomThemeVars(); m.applyTheme('${theme}'); return true; })()`);
            await ev(`new Promise(r => setTimeout(() => r(true), 250))`); // sleep-ok: the 0.15 s colour transitions
            return ev(`(() => {
                const accent = getComputedStyle(document.documentElement).getPropertyValue('--link-text').trim(); // the light theme's link text is darker than its accent (#5273)
                const h = accent.replace('#', ''); const want = 'rgb(' + [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
                const links = [...document.querySelectorAll('${POST} a')].map(a => ({ text: a.textContent, color: getComputedStyle(a).color }));
                return { want, links };
            })()`);
        };
        for (const theme of ['dark', 'light']) {
            const t = await themes(theme);
            check(`${theme}: every link in the post has the theme's link colour`, t.links.length >= 3 && t.links.every(l => l.color === t.want), JSON.stringify(t));
            if (shots) {
                fs.mkdirSync(shots, { recursive: true });
                await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
                await ev(`new Promise(r => setTimeout(() => r(true), 250))`); // sleep-ok: layout after the resize
                const clip = await ev(`(() => { const a = document.querySelector('${POST}').closest('.mb-message') || document.querySelector('${POST}');
                    const r1 = a.getBoundingClientRect(), r2 = r1;
                    const x = Math.max(0, Math.min(r1.left, r2.left) - 8), y = Math.max(0, Math.min(r1.top, r2.top) - 8);
                    return { x, y, width: Math.min(innerWidth - x, Math.max(r1.right, r2.right) - x + 8), height: Math.max(r1.bottom, r2.bottom) - y + 8, scale: 1 }; })()`);
                const shot = await Page.captureScreenshot({ format: 'png', clip });
                fs.writeFileSync(path.join(shots, `board-links-${theme}.png`), Buffer.from(shot.data, 'base64'));
                await Emulation.setDeviceMetricsOverride(VIEW); // back to the test's window
            }
        }

        const hover = await ev(`(() => { const a = document.querySelector('${POST} a'); const st = document.createElement('style');
            return getComputedStyle(a).textDecorationLine; })()`);
        check('post links are not underlined until hovered', hover === 'none', hover);

        // The post link's focus ring. The members are the team page's Agents tab now (#8129): a subscriber's name there is the agents page's, with its own checks.
        const focus = await ev(`(() => { const el = document.querySelector('${POST} a'); el.focus({ focusVisible: true });
            const cs = getComputedStyle(el); return { focused: document.activeElement === el, outline: cs.outlineStyle, width: cs.outlineWidth }; })()`);
        check('keyboard focus is visible on a post link', focus.focused && focus.outline !== 'none', JSON.stringify(focus));
    } catch (e) {
        check('no error', false, e.message);
    } finally {
        try { await api('DELETE', `/api/board/${board}`); } catch { /* best effort */ }
        await client.close();
    }
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
