// A Markdown file's front matter (a skill's name, description, metadata) shows as a small key/value header, not as one run-together paragraph under a rule (#16651, walk 28). The preview's own renderer is driven
// with a SKILL.md-shaped text at 390 and 1280 px; a text whose first --- has no closing one is left as the document it is; the values are text, never markup. Isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const SKILL = '---\nname: pdf-tools\ndescription: Fill and merge PDF forms when an agent is asked to\nmetadata:\n  author: <img src=x onerror=window.__pwn=1>\n---\n\n# PDF tools\n\nBody text here.\n';
const NOT_FRONT = '---\n\nA document that starts with a rule and never closes it.\n';

(async () => {
    const { client, Page, Emulation, ev, PRELOAD, install } = await connect();
    const problems = [];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, mobile] of [[390, true], [1280, false]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: 844, deviceScaleFactor: 1, mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList');
            const out = await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'preview_content.js');
                const draw = t => { const host = document.createElement('div'); document.body.append(host); m._renderContentView(host, t, 'SKILL.md', 0, false); return host; };
                const a = draw(${JSON.stringify(SKILL)}), b = draw(${JSON.stringify(NOT_FRONT)});
                const dl = a.querySelector('dl.preview-front-matter');
                const r = { keys: dl ? Array.from(dl.querySelectorAll('dt')).map(e => e.textContent) : null, vals: dl ? Array.from(dl.querySelectorAll('dd')).map(e => e.textContent) : null, h1: (a.querySelector('h1') || {}).textContent, hr: a.querySelectorAll('hr').length, para: Array.from(a.querySelectorAll('p')).map(e => e.textContent), img: a.querySelectorAll('img').length, pwn: !!window.__pwn, notDl: !!b.querySelector('dl'), notHr: b.querySelectorAll('hr').length, over: dl ? dl.scrollWidth > dl.clientWidth + 1 : null };
                a.remove(); b.remove(); return r; })()`);
            const tag = `${w} px`;
            if (!out.keys) { problems.push(`${tag}: no key/value header was drawn`); continue; }
            if (JSON.stringify(out.keys) !== JSON.stringify(['name', 'description', 'metadata'])) problems.push(`${tag}: keys ${JSON.stringify(out.keys)}`);
            if (out.vals[0] !== 'pdf-tools') problems.push(`${tag}: name value ${out.vals[0]}`);
            if (!/onerror/.test(out.vals[2] || '') || out.img || out.pwn) problems.push(`${tag}: a value ran or became markup (${JSON.stringify(out.vals[2])}, imgs ${out.img})`);
            if (out.h1 !== 'PDF tools' || out.hr !== 0) problems.push(`${tag}: the body is the heading and text only (h1 ${out.h1}, rules ${out.hr})`);
            if (out.para.some(t => /name:|description:/.test(t))) problems.push(`${tag}: the front matter is still in a paragraph: ${JSON.stringify(out.para)}`);
            if (out.over) problems.push(`${tag}: the header is wider than its box`);
            if (out.notDl || out.notHr !== 1) problems.push(`${tag}: an unclosed --- is a rule in the document, not front matter (dl ${out.notDl}, rules ${out.notHr})`);
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the front matter header:\n  ' + problems.join('\n  '));
    console.log('PASS Markdown front matter shows as a key/value header');
})().catch(e => { console.error(e); process.exit(1); });
