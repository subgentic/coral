// A coral://artifacts/<64 hex> in a Markdown file shown in the docked preview pane (the older preview, #12386, QA2's INFO on #12373) is a link like the viewer's: the words as written, the target built from the parsed id on the
// file's own computer, a click opens that file, a reference in code stays text. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const A = 'a1'.repeat(32), A2 = 'a3'.repeat(32), B = 'b2'.repeat(32); // two files, so the second is not the first one's open tab
const MD_A = ['# Notes', '', `The plan is coral://artifacts/${B}.`, '', `In code: \`coral://artifacts/${B}\``].join('\n');

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
            await ev(`(async () => { window.PP = await import(${S} + 'preview_pane.js'); const st = (await import(${S} + 'state.js')).state; st.currentSession = { type: 'live', name: 'fixture', session_id: 'refs-fixture', agent_type: 'claude' }; (await import(${S} + 'utils.js')).showView('live-session-view'); window.PP.setPreviewSession('refs-fixture'); return true; })()`);
            for (const server of [undefined, 'ws1']) {
                const FILE = server ? A2 : A;
                const tag = at + (server ? 'file from another computer: ' : '');
                await ev(`(async () => { const real = window.fetch; window.__urls = [];
                    window.fetch = (u, o) => { const s = String(u && u.url ? u.url : u); window.__urls.push(s);
                        if (s.includes('/api/artifacts/${FILE}')) return Promise.resolve(new Response(${JSON.stringify(MD_A)}, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="notes.md"' } }));
                        return real(u, o); };
                    (window.PP || (window.PP = await import(${S} + 'preview_pane.js'))).openArtifactTab('coral://artifacts/${FILE}', { name: 'notes.md', mediaType: 'text/markdown'${server ? `, server: '${server}'` : ''} }); return true; })()`);
                await waitFor(`!!document.querySelector('#preview-pane .preview-pane-markdown a.mb-artifact-ref')`, tag + 'the reference in the preview is a link', 10000);
                const r = await ev(`(() => { const root = document.querySelector('#preview-pane .preview-pane-markdown'); const links = [...root.querySelectorAll('a.mb-artifact-ref')]; return { links: links.map(a => ({ text: a.textContent, href: a.getAttribute('href'), server: a.dataset.server || '', id: a.dataset.artifact })), code: root.querySelectorAll('code a').length }; })()`);
                check(r.links.length === 1 && r.links[0].text === `coral://artifacts/${B}` && r.links[0].id === B, tag + 'one link, its words as written: ' + JSON.stringify(r.links));
                check(r.links[0] && r.links[0].href === (server ? `/api/remote/${server}/api/artifacts/${B}?v=2` : `/api/artifacts/${B}?v=2`) && r.links[0].server === (server || 'local'), tag + "its target is that file on the file's own computer: " + JSON.stringify(r.links[0]));
                check(r.code === 0, tag + 'a reference in code stays text');
                await ev(`window.PP.closeTab && document.querySelectorAll('#preview-pane .preview-tab-close').forEach(b => b.click()); true`);
            }
        }
    } finally { await client.close(); }
    if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exitCode = 1; } else console.log('PASS a coral://artifacts reference in the docked preview is a link on its own computer');
})().catch(e => { console.error(e); process.exitCode = 1; });
