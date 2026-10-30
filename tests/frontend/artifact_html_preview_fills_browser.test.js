// #11163 (the Operator's shot of Knowledge > an HTML artifact): the sandboxed HTML preview fills the dialog under its "scripts and external resources are disabled" line, and the document scrolls inside it to
// the end: the frame's bottom reaches the dialog body's bottom (it stopped at about 60% of the dialog and left the lower half empty), a long document's last element is reachable, and a short one does not make the
// dialog a strip. At 1400x900 and a 390x844 phone. The bytes come from a stubbed fetch (the artifact store needs an agent session to upload; board_auto_attach_e2e covers that side).
const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');

const BASE = require('./test_base').BASE;
const LONG_HEX = 'a'.repeat(64), SHORT_HEX = 'b'.repeat(64);
const LONG = '<!doctype html><html><body style="margin:0"><h1>Acceptance</h1>' + Array.from({ length: 120 }, (_, i) => `<p>Row ${i + 1}: one line of the table</p>`).join('') + '<p id="last-line">THE LAST ELEMENT</p></body></html>';
const SHORT = '<!doctype html><html><body><p id="last-line">Just one line</p></body></html>';

(async () => {
    const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
    const { Page, Runtime, Emulation } = client;
    const ev = async expression => {
        const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const { coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic||'/static/')`;
    const waitFor = async (expr, what, ms = 8000) => { const until = Date.now() + ms; for (;;) { if (await ev(expr)) return; if (Date.now() > until) throw new Error('timed out waiting for ' + what); await new Promise(r => setTimeout(r, 25)); } };
    // The frame is sandboxed without same-origin (its document is not readable from the page, and Chrome puts it in a process of its own), so what is inside is read as its own target (CDP), the way a person scrolls it
    const targets = new Map();
    client.Target.attachedToTarget(({ sessionId, targetInfo }) => { targets.set(sessionId, targetInfo); });
    client.Target.detachedFromTarget(({ sessionId }) => { targets.delete(sessionId); });
    const inFrame = async (expression) => { const ids = [...targets.keys()].filter(id => targets.get(id).type === 'iframe'); const id = ids[ids.length - 1]; if (!id) return null; try { const r = await client.send('Runtime.evaluate', { expression, returnByValue: true }, id); return r.exceptionDetails ? null : r.result.value; } catch (e) { return null; } };
    try {
        await Promise.all([Page.enable(), Runtime.enable()]);
        await client.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        for (const [w, h, mobile] of [[1400, 900, false], [390, 844, true]]) {
            const tag = mobile ? 'phone' : 'desktop';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired();
            await coralReady();
            await ev(`(() => { const real = window.fetch; const docs = { ${JSON.stringify(LONG_HEX)}: ${JSON.stringify(LONG)}, ${JSON.stringify(SHORT_HEX)}: ${JSON.stringify(SHORT)} };
                window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); for (const k of Object.keys(docs)) if (u.includes('/api/artifacts/' + k)) return Promise.resolve(new Response(docs[k], { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
                    return real(input, init); };
                return true; })()`);
            const geometry = `(() => { const d = document.getElementById('artifact-viewer'), body = d.querySelector('.artifact-viewer-body'), f = body.querySelector('iframe'), note = body.querySelector('.artifact-linked-notice'); if (!f || !note) return null;
                const b = body.getBoundingClientRect(), r = f.getBoundingClientRect(), cs = getComputedStyle(body), pb = parseFloat(cs.paddingBottom) || 0, n = note.getBoundingClientRect(); return { bodyB: Math.round(b.bottom - pb), frameB: Math.round(r.bottom), frameH: Math.round(r.height), noteB: Math.round(n.bottom), contentB: Math.round(d.querySelector('.artifact-viewer-content').getBoundingClientRect().bottom), contentH: Math.round(d.querySelector('.artifact-viewer-content').getBoundingClientRect().height), frameT: Math.round(r.top), bodyH: Math.round(b.height), vh: innerHeight }; })()`;

            console.log(`${tag}: a long HTML document fills the dialog and scrolls to its end`);
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(LONG_HEX)}, { filename: 'pi-acceptance-table.html', mediaType: 'text/html' }))`);
            await waitFor(`!!document.querySelector('#artifact-viewer .artifact-viewer-body iframe')`, 'the frame');
            { const until = Date.now() + 8000; while (!(await inFrame(`!!document.getElementById('last-line')`))) { if (Date.now() > until) throw new Error('timed out waiting for the document in the frame (' + targets.size + ' targets)'); await new Promise(r => setTimeout(r, 50)); } }
            let g = await ev(geometry);
            assert.ok(g && Math.abs(g.bodyB - g.frameB) <= 2, `${tag}: the frame's bottom reaches the dialog body's bottom (within 2 px): ${JSON.stringify(g)}`);
            assert.ok(g.frameT >= g.noteB - 1 && g.frameH >= 240, `${tag}: the frame sits under the banner and is not a strip: ${JSON.stringify(g)}`);
            assert.ok(g.contentH >= g.vh * 0.7 && g.frameH >= g.contentH * 0.6, `${tag}: a long document's dialog is tall and the frame is most of it (nothing empty below): ${JSON.stringify(g)}`);
            const end = await inFrame(`(() => { const el = document.getElementById('last-line'), root = document.scrollingElement; root.scrollTop = root.scrollHeight; const e = el.getBoundingClientRect(); return { top: Math.round(e.top), bottom: Math.round(e.bottom), vh: innerHeight, maxScroll: root.scrollHeight - root.clientHeight, at: Math.round(root.scrollTop) }; })()`);
            assert.ok(end.maxScroll > 0 && end.bottom <= end.vh + 1 && end.top >= 0, `${tag}: scrolled to the end, the last element is in the frame: ${JSON.stringify(end)}`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);

            console.log(`${tag}: a short document does not make the dialog a strip`);
            await ev(`import(${S}+'artifact_viewer.js').then(m => m.openArtifactViewer(${JSON.stringify(SHORT_HEX)}, { filename: 'one.html', mediaType: 'text/html' }))`);
            { const until = Date.now() + 8000; while (!(await inFrame(`!!document.getElementById('last-line')`))) { if (Date.now() > until) throw new Error('timed out waiting for the short document'); await new Promise(r => setTimeout(r, 50)); } }
            g = await ev(geometry);
            assert.ok(Math.abs(g.bodyB - g.frameB) <= 2 && g.frameH >= 240, `${tag}: a short document's frame still fills its body: ${JSON.stringify(g)}`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click()`);
        }
        for (const [w, h, mobile] of [[1400, 900, false], [390, 844, true]]) {
            const tag = (mobile ? 'phone' : 'desktop') + ' Knowledge pane';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired();
            await coralReady();
            await ev(`(() => { const real = window.fetch; window.fetch = (input, init) => { const u = String(input && input.url ? input.url : input); if (u.includes('/api/artifacts/' + ${JSON.stringify(LONG_HEX)})) return Promise.resolve(new Response(${JSON.stringify(LONG)}, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })); return real(input, init); }; return true; })()`);
            console.log(`${tag}: the detail pane's HTML preview fills the pane under the banner`);
            await ev(`Promise.all([import(${S}+'detail_pane.js'), import(${S}+'artifact_preview.js')]).then(([d, a]) => { const host = document.createElement('div'); host.id = 'test-pane-host'; host.style.cssText = 'position:fixed;top:56px;right:0;bottom:0;width:' + Math.min(560, innerWidth) + 'px;display:flex;flex-direction:column;z-index:50;background:var(--bg-primary)'; document.body.append(host); d.openDetailPane({ host, key: 'pi-acceptance-table', title: 'pi-acceptance-table', sub: 'HTML', body: (host, ctx) => a.renderArtifact(host, 'coral://artifacts/${LONG_HEX}', { filename: 'pi-acceptance-table.html', mediaType: 'text/html' }, { signal: ctx.signal, isStale: ctx.isStale, renderContent() {}, openEntry() {}, setMeta() {} }) }); return true; })`);
            await waitFor(`!!document.querySelector('.detail-body iframe')`, 'the pane\'s frame');
            { const until = Date.now() + 8000; while (!(await inFrame(`!!document.getElementById('last-line')`))) { if (Date.now() > until) throw new Error('timed out waiting for the pane document'); await new Promise(r => setTimeout(r, 50)); } }
            const pg = await ev(`(() => { const b = document.querySelector('.detail-body'), f = b.querySelector('iframe'), cs = getComputedStyle(b), r = f.getBoundingClientRect(), bb = b.getBoundingClientRect(); return { bodyB: Math.round(bb.bottom - (parseFloat(cs.paddingBottom) || 0)), frameB: Math.round(r.bottom), frameH: Math.round(r.height), bodyH: Math.round(bb.height) }; })()`);
            assert.ok(Math.abs(pg.bodyB - pg.frameB) <= 2 && pg.frameH >= pg.bodyH * 0.6, `${tag}: the frame's bottom reaches the pane body's bottom (within 2 px): ${JSON.stringify(pg)}`);
            const pend = await inFrame(`(() => { const el = document.getElementById('last-line'), root = document.scrollingElement; root.scrollTop = root.scrollHeight; const e = el.getBoundingClientRect(); return { top: Math.round(e.top), bottom: Math.round(e.bottom), vh: innerHeight, maxScroll: root.scrollHeight - root.clientHeight }; })()`);
            assert.ok(pend && pend.maxScroll > 0 && pend.bottom <= pend.vh + 1 && pend.top >= 0, `${tag}: scrolled to the end, the last element is in the frame: ${JSON.stringify(pend)}`);
        }
        console.log('\nPASS the HTML preview fills the dialog');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
