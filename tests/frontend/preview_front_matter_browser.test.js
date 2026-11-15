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
                for (let i = 0; i < 60 && !a.querySelector('dl.preview-front-matter'); i++) await new Promise(r => setTimeout(r, 50)); // sleep-ok: the header module loads on first use
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
        // #17927 (Security INFO on #16651): a header module that cannot load leaves the preview as drawn and raises no unhandled rejection
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList');
        await client.Network.enable(); await client.Network.setBlockedURLs({ urls: ['*md_front.js*'] });
        const blocked = await ev(`(async () => { window.__unh = 0; window.addEventListener('unhandledrejection', () => { window.__unh++; });
            const m = await import((window.__coralStatic || '/static/') + 'preview_content.js'); const host = document.createElement('div'); document.body.append(host);
            m._renderContentView(host, ${JSON.stringify(SKILL)}, 'SKILL.md', 0, false); await new Promise(r => setTimeout(r, 2500)); // sleep-ok: the failed load is tried once more, then given up
            const r = { unhandled: window.__unh, h1: (host.querySelector('h1') || {}).textContent, dl: !!host.querySelector('dl'), failed: true }; host.remove(); return r; })()`);
        await client.Network.setBlockedURLs({ urls: [] });
        if (blocked.unhandled !== 0) problems.push(`a header module that cannot load raised ${blocked.unhandled} unhandled rejection(s)`);
        if (blocked.h1 !== 'PDF tools' || blocked.dl) problems.push(`a header module that cannot load leaves the preview as drawn (h1 ${blocked.h1}, header ${blocked.dl})`);
        // #17927 (QA5 SHOULD): the block in view stays where it is when the front matter is swapped for the header
        const keys = Array.from({ length: 14 }, (_, i) => `key${i}: a value that is long enough to take its own line in the old run-together paragraph ${i}`).join('\n');
        const LONG = '---\n' + keys + '\n---\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: some body text that fills a line or two of the preview.`).join('\n\n') + '\n';
        const kept = await ev(`(async () => { const host = document.createElement('div'); host.style.cssText = 'height:300px;overflow:auto;position:fixed;top:0;left:0;width:600px;background:#fff'; document.body.append(host);
            host.innerHTML = '<div class="prose preview-pane-markdown">' + marked.parse(${JSON.stringify(LONG)}) + '</div>'; // the first render: the front matter run together
            const prose = host.firstElementChild, top = el => el.getBoundingClientRect().top - host.getBoundingClientRect().top;
            host.scrollTop = 900; await new Promise(r => requestAnimationFrame(r));
            const pick = Array.from(prose.querySelectorAll('p')).find(p => /^Paragraph \\d+/.test(p.textContent) && top(p) >= 0), label = pick.textContent.slice(0, 14), before = top(pick);
            const fm = await import((window.__coralStatic || '/static/') + 'md_front.js?t=1'); await fm.show(host, ${JSON.stringify(LONG)}); await new Promise(r => requestAnimationFrame(r));
            const again = Array.from(host.querySelectorAll('p')).find(p => p.textContent.startsWith(label)); const r = { label, before: Math.round(before), after: again ? Math.round(top(again)) : null, dl: !!host.querySelector('dl') }; host.remove(); return r; })()`);
        if (!kept.dl) problems.push('the header was not drawn in the scroll check');
        else if (kept.after === null || Math.abs(kept.after - kept.before) > 2) problems.push(`the block in view moved when the header was drawn: ${kept.label} was ${kept.before} px from the top, now ${kept.after}`);
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the front matter header:\n  ' + problems.join('\n  '));
    console.log('PASS Markdown front matter shows as a key/value header');
})().catch(e => { console.error(e); process.exit(1); });
