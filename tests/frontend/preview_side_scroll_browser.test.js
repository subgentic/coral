// The artifact preview in the side panel scrolls (#14846, the Operator: "I can't scroll down in the preview mode unless I expand to full width"): a tall Markdown file and a tall HTML file, opened as the Artifact tab
// beside the chat, scroll with the mouse wheel and the keyboard (PageDown, Space), and the end of the file becomes visible; at 1280 px and in the narrow split (a 1024 px window). Real wheel events over the preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady, framesJs } = require('./helpers/wait');

// the Operator's own file (a review question with a table of coral:// links, whose cells wrap to many lines in a narrow pane), then a tall tail so the end is far down
const MD = "# Dropbox removal confirms: do they say clearly what gets deleted?\n\nThese confirms delete from your Dropbox, so you see them before they land (stage 6a, #14814, at `2cca5b39d`). Nothing is removed without them.\n\n| Confirm | Desktop (1280) | Phone (390) |\n|---|---|---|\n| Remove from Dropbox (an artifact's Details) | coral://artifacts/144a549a9c73737c394e13922a940c9f8b42f2be8d02c714409abd54f06d8a58 | coral://artifacts/29b47766db0637cce9dac9de94bf3057bb32293c3ea7c34fc288213ec273c8b9 |\n| The same, when another Coral keeps the file only in Dropbox: type its last 4 characters | coral://artifacts/a065759665541631e4f9b6fb2b78f105880f88555e1bfbe5f5cef3f4276c38aa | coral://artifacts/adbb6686bb259ad51b5d1024cb661761237ceccbcfbf2f9264ed5628a9b51101 |\n| Mark private and remove | coral://artifacts/55da5f524c8272c911217ff25dc8abfba8a31657afc69f27f7cc26bc5adec903 | coral://artifacts/7827651aaa9c0a39f59883fe237efc8641b2d11a108ccbb5ffccbc5d26d0867e |\n| After a removal: Send to Dropbox again | coral://artifacts/9a3c6f2b3f10b28bb5e672833095febecb15be86bc7edf12c86ff8cae323c90d | coral://artifacts/4df34a1de114d4a6eb0a9c747b32a3dc473dc2808acc86af7ebbb2f26cef95ec |\n| Settings: Disconnect and delete the backup (typed confirm) | coral://artifacts/2ca0d1fe0dcebd230bd55628c6e49bdef3a5753444b3873b0ee63cc050109fe9 | coral://artifacts/c072c0ba7e0e84fadeda6b38a1a08fd1bb31ae67b7afaa144e9af09547996512 |\n\n## What each one says\n\n- **Remove from Dropbox:** \"Remove it from Dropbox for every Coral that uses this backup. Dropbox may keep it for a while in its deleted files. It stays out of the backup until you send it again.\" The copy on this computer is never touched.\n- **Another Coral keeps it only in Dropbox:** names that Coral by the last 4 characters of its id and says removing it loses it there; you type those characters.\n- **Mark private and remove:** the same, after marking the artifact private here.\n- **Disconnect and delete the backup:** says how many files, how many did not come from this computer, which other Corals lose files, and that Dropbox may keep deleted files for a while; you type the words shown. Coral disconnects only once Dropbox has finished deleting.\n\nThe keyboard starts on Cancel (or on the field you must type in), so a stray Enter never deletes anything.\n" + '\n\n' + Array.from({ length: 40 }, (_, i) => `### More ${i + 1}\n\nParagraph ${i + 1} after the table, with enough words to wrap in a narrow panel.\n`).join('\n') + '\nTHE END OF THE MARKDOWN.\n';
const HTML = '<h1>Tall page</h1>' + Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1} of the tall page, with enough words to wrap on a narrow panel.</p>`).join('') + '<p id="end">THE END OF THE HTML.</p>';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (ok, msg) => { if (!ok) problems.push(msg); };
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const wheel = (x, y, dy, dx = 0) => client.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
    const key = async (k, code, text) => { await client.Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: k === 'PageDown' ? 34 : 32 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'PageDown' ? 34 : 32 }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, kind, dock, withComments] of [[1280, 800, 'md', 'bottom'], [1024, 768, 'md', 'bottom'], [1280, 800, 'html', 'bottom'], [1024, 768, 'html', 'bottom'], [1280, 800, 'md', 'column'], [1024, 768, 'md', 'column'], [1280, 800, 'md', 'column', true], [1024, 768, 'md', 'column', true], [1280, 800, 'md', 'bottom', true], [1280, 800, 'html', 'column'], [1024, 768, 'html', 'column']]) {
            const at = `${w} px, ${kind}, docked ${dock === 'column' ? 'as a column' : 'at the bottom'}${withComments ? ', with comments' : ''}: `, body = kind === 'md' ? MD : HTML, type = kind === 'md' ? 'text/markdown' : 'text/html';
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile: false });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.setItem('coral-preview-pane-dock', '${dock}'); true`); await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`localStorage.setItem('coral-agentic-collapsed', 'false'); localStorage.setItem('coral-preview-pane-dock', '${dock}'); window.__m.add('coral-go', 'm', 6, { sleeping: false, session_id: 'o1' }); true`);
            await new Promise(r => setTimeout(r, 600)); // sleep-ok: the list renders from several answers
            await ev(`window.selectLiveSession('coral-go', 'claude', 'o1', 'local'); true`);
            await waitFor(`!!document.getElementById('command-input')`, `${at}the agent`, 10000);
            const hex = (kind === 'md' ? 'a1' : 'b2').repeat(32);
            await ev(`(() => { const real = window.fetch, json = b => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })); window.fetch = (u, o) => { const url = String(u); if (/\\/api\\/artifacts\\/${hex}\\/comments/.test(url)) return json({ comments: ${withComments ? "[{ id: 'c1', author: 'Operator', kind: 'owner', text: 'First comment', created_at: new Date().toISOString(), resolved: false }, { id: 'c2', author: 'Dev', kind: 'agent', text: 'A reply', created_at: new Date().toISOString(), resolved: false }]" : '[]'}, locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} }); if (/\\/api\\/artifacts\\/${hex}\\/versions/.test(url)) return json([]); return /\\/api\\/artifacts\\/${hex}/.test(url) ? Promise.resolve(new Response(${JSON.stringify(body)}, { status: 200, headers: { 'Content-Type': '${type}' } })) : real(u, o); }; return true; })()`); // the comments and versions the viewer asks for (the Comments button is part of the pane)
            await ev(`import(${S} + 'preview_pane.js').then(m => m.openArtifactTab('coral://artifacts/${hex}', { filename: 'tall.${kind === 'md' ? 'md' : 'html'}', mediaType: '${type}', sourceNamed: true })); true`);
            await waitFor(kind === 'md' ? `!!document.querySelector('.preview-pane-markdown, .preview-pane .md') && /Dropbox removal confirms/.test(document.querySelector(".preview-pane").innerText)` : `!!document.querySelector('.preview-pane iframe')`, `${at}the preview`, 10000);
            await ev(framesJs(4));
            // the scrolling element: the first ancestor of the content (or the content itself) that can scroll, and where the pane is on screen
            const geo = await ev(`(() => { const pane = document.querySelector('.preview-pane'), r = pane.getBoundingClientRect();
                const probe = ${kind === 'md' ? `pane.querySelector('.preview-pane-markdown, .md') || pane` : `pane.querySelector('iframe')`};
                let sc = null; for (let e = probe; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4) { sc = e; break; } }
                const pr = probe.getBoundingClientRect();
                return { pane: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], probe: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)], scroller: sc ? (sc.id || sc.className).toString().slice(0, 60) : null, canScroll: !!sc, table: (() => { const t = pane.querySelector('table'); if (!t) return null; const b = t.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + Math.min(b.height / 2, 120))]; })() }; })()`);
            check(geo.pane[2] > 100 && geo.pane[3] > 100, `${at}the side panel's preview is on screen: ${JSON.stringify(geo)}`);
            check(kind === 'html' || geo.canScroll, `${at}something in the preview can scroll: ${JSON.stringify(geo)}`);
            const read = () => ev(kind === 'md' ? `(() => { const pane = document.querySelector('.preview-pane'); const end = [...pane.querySelectorAll('p')].find(p => /THE END OF THE MARKDOWN/.test(p.textContent)); let sc = null; for (let e = pane.querySelector('.preview-pane-markdown, .md') || pane; e && e !== document.documentElement; e = e.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) { sc = e; break; } }
                    const r = end && end.getBoundingClientRect(), p = pane.getBoundingClientRect(); return { top: sc ? Math.round(sc.scrollTop) : -1, endVisible: !!r && r.top >= p.top && r.bottom <= p.bottom + 2 }; })()` : `({ top: -1, endVisible: false })`);
            const cx = geo.pane[0] + geo.pane[2] / 2, cy = geo.pane[1] + geo.pane[3] / 2;
            if (kind === 'md') {
                const before = await read();
                for (let i = 0; i < 6; i++) await wheel(cx, cy, 400);
                await ev(framesJs(3));
                const after = await read();
                check(after.top > before.top, `${at}the mouse wheel over the preview scrolls it (scrollTop ${before.top} -> ${after.top})`);
                // the pointer over the file's table (a wide one: its own sideways scroller), with the little sideways drift of a trackpad: the page still scrolls down
                await ev(`(() => { const pane = document.querySelector('.preview-pane'); let sc = null; for (let e = pane.querySelector('.preview-pane-markdown, .md') || pane; e && e !== document.documentElement; e = e.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) { sc = e; break; } } if (sc) sc.scrollTop = 0; return true; })()`);
                await ev(framesJs(3));
                const tb = await ev(`(() => { const t = document.querySelector('.preview-pane table'), pn = document.querySelector('#preview-body'); if (!t) return null; const b = t.getBoundingClientRect(), v = pn.getBoundingClientRect(); const top = Math.max(b.top, v.top), bot = Math.min(b.bottom, v.bottom, innerHeight), l = Math.max(b.left, v.left), r = Math.min(b.right, v.right); return bot - top > 20 && r - l > 20 ? [Math.round((l + r) / 2), Math.round((top + bot) / 2)] : null; })()`); // the part of the table that is on screen, inside the preview
                const t0 = (await read()).top;
                if (tb) for (let i = 0; i < 6; i++) await wheel(tb[0], tb[1], 120, 4);
                await ev(framesJs(3));
                const t1 = (await read()).top;
                check(!!tb && t1 > t0, `${at}the wheel over the file's table, with a sideways drift, scrolls the page down (scrollTop ${t0} -> ${t1}, the table at ${JSON.stringify(tb)})`);
                await ev(`(() => { const pane = document.querySelector('.preview-pane'); let sc = null; for (let e = pane.querySelector('.preview-pane-markdown, .md') || pane; e && e !== document.documentElement; e = e.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) { sc = e; break; } } if (sc) { sc.tabIndex = -1; sc.focus(); } return true; })()`);
                const k0 = (await read()).top; await key('PageDown', 'PageDown'); await ev(framesJs(3)); const k1 = (await read()).top;
                check(k1 > k0, `${at}PageDown scrolls it when it has the focus (${k0} -> ${k1})`);
                if (withComments) { // the person opens the comments and closes them again: the file scrolls both ways (the sheet is not a trap)
                    await ev(`document.querySelector('.preview-pane .ac-toggle').click(); true`); await ev(framesJs(3));
                    const open = await ev(`!!document.querySelector('.preview-pane .ac-panel.ac-sheet-open') && getComputedStyle(document.querySelector('.preview-pane .ac-panel')).display !== 'none'`);
                    check(open, `${at}Comments opens the panel when asked`);
                    const topOpen = await ev(`(() => { const r = document.querySelector('.preview-pane #preview-body').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + 40)]; })()`);
                    const o0 = (await read()).top; for (let i = 0; i < 4; i++) await wheel(topOpen[0], topOpen[1], 120); await ev(framesJs(3)); const o1 = (await read()).top;
                    check(o1 > o0, `${at}with the comments open, the part of the file above them still scrolls (${o0} -> ${o1})`);
                    await ev(`document.querySelector('.preview-pane .ac-panel .ac-sheet-close, .preview-pane .ac-toggle').click(); true`); await ev(framesJs(3));
                }
                for (let i = 0; i < 60; i++) await wheel(cx, cy, 800);
                await ev(framesJs(3));
                const end = await read();
                check(end.endVisible, `${at}the end of the file becomes visible: ${JSON.stringify(end)}`);
            } else {
                // the HTML is a sandboxed frame: the wheel over it scrolls the frame's own document; read its position through the debugger
                const frameTop = async () => { const { targetInfos } = await client.Target.getTargets(); const t = targetInfos.find(x => x.type === 'iframe' && x.url === 'about:srcdoc'); if (!t) return null; const { sessionId } = await client.Target.attachToTarget({ targetId: t.targetId, flatten: true }); try { const r = await client.send('Runtime.evaluate', { expression: `JSON.stringify({ y: Math.round(window.scrollY), max: document.documentElement.scrollHeight - innerHeight, endVisible: (() => { const e = document.getElementById('end').getBoundingClientRect(); return e.bottom <= innerHeight + 2; })() })`, returnByValue: true }, sessionId); return JSON.parse(r.result.value); } finally { await client.Target.detachFromTarget({ sessionId }).catch(() => {}); } };
                const b = await frameTop();
                for (let i = 0; i < 6; i++) await wheel(cx, cy, 400);
                await new Promise(r => setTimeout(r, 300)); // sleep-ok: the frame scrolls in its own process
                const a = await frameTop();
                check(!!b && !!a && a.y > b.y, `${at}the mouse wheel over the HTML preview scrolls it (${JSON.stringify(b)} -> ${JSON.stringify(a)})`);
                for (let i = 0; i < 60; i++) await wheel(cx, cy, 800);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: as above
                const e = await frameTop();
                check(!!e && e.endVisible, `${at}the end of the HTML becomes visible: ${JSON.stringify(e)}`);
            }
            await shot(`preview-side-${kind}-${dock}${withComments ? '-comments' : ''}-${w}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('preview_side_scroll_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
