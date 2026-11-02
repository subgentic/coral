// A coral://artifacts/<64 hex> written in a rendered Markdown file is a link that opens that file in the viewer (#12361, the operator's Goal #189 README). Exactly that form: the link's words stay as written
// (upper-case hex too), its target is built from the parsed id, a reference in code or a longer run of digits is left as text, and no javascript: or outside address is made. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const A = 'a1'.repeat(32), B = 'b2'.repeat(32), C = 'c3'.repeat(32);
const MD_A = [
    '# Goal notes', '',
    `See coral://artifacts/${B} for the plan and coral://artifacts/${C.toUpperCase()} too.`, '',
    `In code: \`coral://artifacts/${B}\``, '',
    '```', `coral://artifacts/${B}`, '```', '',
    `Too long: coral://artifacts/${B}ff and [bad](javascript:alert(1)) and coral://artifacts/xyz.`,
].join('\n');
const MD_B = '# The plan\n\nSecond file text.';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const failures = [], check = (ok, what) => { if (!ok) failures.push(what); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => { const real = window.fetch; window.__navs = [];
                window.fetch = (u, o) => { const s = String(u && u.url ? u.url : u);
                    if (s.includes('/api/artifacts/${A}')) return Promise.resolve(new Response(${JSON.stringify(MD_A)}, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="notes.md"' } }));
                    if (s.includes('/api/artifacts/${B}')) return Promise.resolve(new Response(${JSON.stringify(MD_B)}, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="plan.md"' } }));
                    return real(u, o); };
                return true; })()`);
            await ev(`import(${S} + 'artifact_viewer.js').then(m => { m.openArtifactViewer('${A}', { filename: 'notes.md' }); return true; })`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref')`, at + 'the references in the file are links', 10000);
            const r = await ev(`(() => { const root = document.querySelector('#artifact-viewer .artifact-viewer-markdown'); const links = [...root.querySelectorAll('a.mb-artifact-ref')];
                return { links: links.map(a => ({ text: a.textContent, href: a.getAttribute('href'), target: a.target, rel: a.rel, id: a.dataset.artifact })), codeLinks: root.querySelectorAll('code a, pre a').length,
                    js: [...root.querySelectorAll('a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length, text: root.textContent }; })()`);
            check(r.links.length === 2, at + 'exactly the two well-formed references are links: ' + JSON.stringify(r.links));
            check(r.links[0] && r.links[0].text === `coral://artifacts/${B}` && r.links[0].id === B, at + 'the link text stays as written: ' + JSON.stringify(r.links[0]));
            check(r.links[1] && r.links[1].text === `coral://artifacts/${C.toUpperCase()}` && r.links[1].id === C, at + 'upper-case hex is shown as written and linked by the lower-case id: ' + JSON.stringify(r.links[1]));
            check(r.links.every(l => l.href === `/api/artifacts/${l.id}?v=2` && l.target === '_blank' && /noopener/.test(l.rel)), at + 'the target is built from the id, with the new-tab fallback: ' + JSON.stringify(r.links.map(l => l.href)));
            check(r.codeLinks === 0, at + 'a reference in code is left as text');
            check(r.js === 0 && r.text.includes(`coral://artifacts/${B}ff`) && r.text.includes('coral://artifacts/xyz'), at + 'a too-long reference and a malformed one stay text, and no javascript: link is made');
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-markdown a.mb-artifact-ref').click(); true`);
            await waitFor(`/Second file text/.test(document.querySelector('#artifact-viewer .artifact-viewer-markdown')?.textContent || '')`, at + 'a plain click opens the named file in the viewer', 10000).catch(e => check(false, at + e.message));
            check(await ev(`document.querySelectorAll('#artifact-viewer:not([hidden])').length === 1`), at + 'one viewer is open');
            // the question dialog draws an agent's Markdown too: the same rule there
            await ev(`document.querySelector('#artifact-viewer [data-dialog-close], #artifact-viewer .artifact-viewer-close')?.click(); true`);
            const q = await ev(`import(${S} + 'operator_asks.js').then(async m => { m.openAskDialog({ asker: 'Orchestrator', board: 'x', board_label: 'sprout', kind: 'wait', text: 'Which one?\\n\\nI wrote it up in coral://artifacts/${A} and the plan is coral://artifacts/${B}.' }); const d = document.querySelector('dialog.inbox-ask-dialog[open]'); for (let i = 0; i < 60 && !d.querySelector('a.mb-artifact-ref'); i++) await new Promise(r => setTimeout(r, 50)); const links = [...d.querySelectorAll('a.mb-artifact-ref')].map(a => [a.textContent, a.dataset.artifact]); d.close(); d.remove(); return links; })`);
            check(q.length === 2 && q[0][0] === `coral://artifacts/${A}` && q[1][1] === B, at + 'the question dialog links its references too, the words as written: ' + JSON.stringify(q));
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS a coral://artifacts reference in a rendered Markdown file is a link that opens that file');
})().catch(e => { console.error(e); process.exitCode = 1; });
