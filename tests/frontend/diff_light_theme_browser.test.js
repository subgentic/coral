// The file viewer's diff follows the theme (#7654, UI Accessibility's report item 10, UI/UX's call): One Dark only in the dark theme; in the light theme
// a light editor with softened green and red blocks. Both themes: the added and removed blocks differ from the page and from each other, and the text on
// them has at least 4.5:1 contrast. The file endpoints are answered in the page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

const BASE = require('./test_base').BASE;

const ORIGINAL = ['package main', '', 'import "fmt"', '', 'func greet(name string) string {', '\treturn "hello " + name', '}', '', 'func main() {', '\tfmt.Println(greet("world"))', '}', ''].join('\n');
const CURRENT = ['package main', '', 'import "fmt"', '', 'func greet(name string) string {', '\treturn "Hello, " + name + "!"', '}', '', 'func main() {', '\tfmt.Println(greet("world"))', '\tfmt.Println("done")', '}', ''].join('\n');
// 400 lines with three edits far apart (line 20 changed, line 200 removed, line 380 added after).
const LONG_ORIGINAL = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i}; // line ${i}`);
const LONG_CURRENT = LONG_ORIGINAL.slice();
LONG_CURRENT[20] = 'const v20 = 2000; // line 20 changed';
LONG_CURRENT.splice(200, 1);
LONG_CURRENT.splice(379, 0, 'const added = true; // after line 379');

const FILES = `(() => {
    const files = ${JSON.stringify({
        '/src/main.go': { original: ORIGINAL, current: CURRENT },
        '/src/long.js': { original: LONG_ORIGINAL.join('\n'), current: LONG_CURRENT.join('\n') },
    })};
    const inner = window.fetch;
    const reply = content => Promise.resolve(new Response(JSON.stringify({ content }), { status: 200, headers: { 'content-type': 'application/json' } }));
    window.fetch = (url, opts) => {
        const u = new URL(String(url), location.origin);
        const f = files['/' + String(u.searchParams.get('filepath')).replace(/^[/]+/, '')];
        if (f && /\\/file-original$/.test(u.pathname)) return reply(f.original);
        if (f && /\\/file-content$/.test(u.pathname) && !(opts && opts.method === 'PUT')) return reply(f.current);
        return inner(url, opts);
    };
})();`;


(async () => {
    const { client, Page, ev, waitFor, PRELOAD, install } = await connect();
    const { waitStable } = require('./helpers/wait').bind(ev);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const open = async theme => {
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); (async () => { const pp = await import((window.__coralStatic || '/static/') + 'preview_pane.js'); pp.openPreviewTab('src/main.go', 1, { mode: 'diff', diff: true }); return true; })()`);
        await waitFor(`!!document.querySelector('#preview-pane .cm-editor') && document.querySelectorAll('#preview-pane .cm-changedLine').length === 2`, `the ${theme} diff`, 8000);
        await waitStable(`document.querySelectorAll('#preview-pane .cm-line').length`, 'the view to settle', 200).catch(() => {});
    };
    const measure = () => ev(`(() => { const lum = c => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const rgba = c => c.match(/[\\d.]+/g).map(Number); const over = (top, base) => { const [r, g, b, a = 1] = rgba(top), [R, G, B] = rgba(base); return \`rgb(\${r * a + R * (1 - a)}, \${g * a + G * (1 - a)}, \${b * a + B * (1 - a)})\`; };
        const ed = document.querySelector('#preview-pane .cm-editor'), content = ed.querySelector('.cm-content'); const eff = el => { for (; el; el = el.parentElement) { const c = getComputedStyle(el).backgroundColor, m = c.match(/[\\d.]+/g).map(Number); if ((m[3] ?? 1) > 0) return c; } return 'rgb(255, 255, 255)'; }; const base = eff(ed);
        const add = document.querySelector('#preview-pane .cm-changedLine'), del = document.querySelector('#preview-pane .cm-deletedChunk');
        const ratio = (fg, back) => { const a = lum(fg), b = lum(back); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
        const addBg = over(getComputedStyle(add).backgroundColor, base), delBg = over(getComputedStyle(del).backgroundColor, base);
        const text = getComputedStyle(content).color;
        return { editorLum: lum(base), addAlpha: rgba(getComputedStyle(add).backgroundColor)[3], delAlpha: rgba(getComputedStyle(del).backgroundColor)[3], addContrast: ratio(text, addBg), delContrast: ratio(text, delBg), addDiffers: addBg !== base, delDiffers: delBg !== base, addVsDel: addBg !== delBg }; })()`);
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: FILES });
        await Page.navigate({ url: BASE });
        await Page.loadEventFired();
        await install();
        await ev(`localStorage.setItem('coral-live-view-mode', 'chat'); window.__m.add('ed-a', 'A', 3, { sleeping: false }); true`);
        await ev(`window.selectLiveSession('ed-a', 'claude', 'ed-a-id', 'local'); true`);

        console.log('1. Light theme: a light editor, softened blocks');
        await open('light');
        const light = await measure();
        assert.ok(light.editorLum > 0.6, 'the editor is light in the light theme: ' + JSON.stringify(light));
        assert.ok(light.addAlpha > 0 && light.addAlpha <= 0.2 && light.delAlpha > 0 && light.delAlpha <= 0.2, 'the blocks are softened: ' + JSON.stringify(light));
        assert.ok(light.addDiffers && light.delDiffers && light.addVsDel, 'added and removed blocks read apart from the page and each other: ' + JSON.stringify(light));
        assert.ok(light.addContrast >= 4.5 && light.delContrast >= 4.5, 'text on the blocks is readable: ' + JSON.stringify(light));

        await shot('diff-light');
        console.log('2. Dark theme: One Dark, as before');
        await ev(`(async () => { const pp = await import((window.__coralStatic || '/static/') + 'preview_pane.js'); pp.closeAllTabs(); return true; })()`).catch(() => {});
        await open('dark');
        const dark = await measure();
        assert.ok(dark.editorLum < 0.1, 'the editor is dark in the dark theme: ' + JSON.stringify(dark));
        assert.ok(dark.addAlpha >= 0.2 && dark.delAlpha >= 0.2, 'the dark blocks keep their strength: ' + JSON.stringify(dark));
        assert.ok(dark.addContrast >= 4 && dark.delContrast >= 4 && dark.addVsDel, 'and are as readable as they were (unchanged): ' + JSON.stringify(dark));
        console.log('PASS diff viewer follows the theme');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
