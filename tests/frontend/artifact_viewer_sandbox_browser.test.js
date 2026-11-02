// The HTML preview's banner and the question line are slim (#12224, slice b of the compact viewer the operator approved): a sandboxed HTML file opens with its banner shown ONCE (then a "Sandboxed" chip in the header says it,
// with the explanation in its tooltip and a tap to show or hide the banner), and the line under the header (who sent it and what they ask) is one muted line with an ellipsis whose whole text is a tap (or Enter) away, not a
// wrapped paragraph. A for-review HTML file with a long question, the routes stubbed. 1280 px and 390 px; it prints the height from the dialog's top to the preview frame (the design's measurement) and asserts it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const HEX = 'ab'.repeat(32);
const FROM = 'Writer A · launch-team · asks: Is the spring launch plan ready to share with the whole company, and are the budget lines in section 3 final or still moving? I need to know before Friday, because the board meets on Monday morning and the deck goes out to the whole company, the partners and the press at the same time, so a late change would mean sending it all twice.';
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`localStorage.removeItem('coral-sandbox-note'); (() => { const orig = window.fetch.bind(window); window.fetch = (u, o) => { const url = String(u);
                if (url.includes('/api/artifacts/${HEX}') && !/versions|comments/.test(url)) return Promise.resolve(new Response('<h1>Launch plan</h1><p>Ship it.</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
                if (/\\/api\\/artifacts\\/${HEX}\\/(versions|comments)/.test(url)) return Promise.resolve(new Response(JSON.stringify(/comments/.test(url) ? { comments: [], locked: false, you: { kind: 'owner', can_comment: true, can_lock: true }, limits: {} } : []), { status: 200, headers: { 'Content-Type': 'application/json' } }));
                return orig(u, o); }; return true; })()`);
            const open = async () => { await ev(`import(${S} + 'artifact_viewer.js').then(v => v.openArtifactViewer('${HEX}', { filename: 'launch-plan.html', mediaType: 'text/html', from: ${JSON.stringify(FROM)} })).then(() => true)`); await waitFor(`!!document.querySelector('#artifact-viewer .artifact-linked-preview iframe')`, `${w}: the HTML preview`, 10000); };
            const read = () => ev(`(() => { const d = document.querySelector('.artifact-viewer-content'), from = d.querySelector('.artifact-viewer-from'), note = d.querySelector('.artifact-linked-notice'), chip = d.querySelector('.artifact-viewer-sandbox'), frame = d.querySelector('.artifact-linked-preview iframe'); const vis = e => !!e && !e.hidden && e.getClientRects().length > 0;
                return { above: Math.round(frame.getBoundingClientRect().top - d.getBoundingClientRect().top), noteShown: vis(note), chip: !!chip && !chip.hidden && vis(chip), chipTitle: chip ? chip.title : '', chipExpanded: chip ? chip.getAttribute('aria-expanded') : null,
                    fromH: Math.round(from.getBoundingClientRect().height), fromCut: from.scrollWidth > from.clientWidth + 1, fromTitle: from.title, fromTap: from.getAttribute('aria-expanded'), fromLines: Math.round(from.getBoundingClientRect().height / (parseFloat(getComputedStyle(from).lineHeight) || 18)) }; })()`);
            await open(); let a = await read();
            console.log(`   ${w}: first open: ${a.above} px from the dialog's top to the preview (banner ${a.noteShown ? 'shown' : 'hidden'}, question line ${a.fromLines} line(s))`);
            await shot('sandbox-first-' + w);
            assert.ok(a.noteShown && a.chip, `${w}: the first time the banner is shown, and the Sandboxed chip is in the header: ` + JSON.stringify(a));
            assert.ok(/scripts/i.test(a.chipTitle), `${w}: the chip's tooltip carries the explanation: ${a.chipTitle}`);
            assert.ok(a.fromLines <= 1 && a.fromCut && a.fromTitle.includes('budget lines') && a.fromTap === 'false', `${w}: the question is one cut line, its whole text in the tooltip and a tap away: ` + JSON.stringify({ lines: a.fromLines, cut: a.fromCut, tap: a.fromTap }));
            // the next time: the chip alone
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`); await open(); a = await read();
            console.log(`   ${w}: next open: ${a.above} px to the preview`);
            await shot('sandbox-next-' + w);
            assert.ok(!a.noteShown && a.chip && a.chipExpanded === 'false', `${w}: the next time the banner is gone and the chip stays: ` + JSON.stringify(a));
            assert.ok(a.above <= (w === 390 ? 260 : 120), `${w}: the controls and lines above the preview take at most ${w === 390 ? 260 : 120} px (they take ${a.above})`);
            // a tap on the chip shows the banner and hides it again
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-sandbox').click(); true`);
            assert.ok((await read()).noteShown, `${w}: a tap on the chip shows the banner`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-sandbox').click(); true`);
            assert.ok(!(await read()).noteShown, `${w}: and another hides it`);
            // the question line: a tap shows all of it, another puts it back
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-from').click(); true`);
            let f = await read(); assert.ok(f.fromLines >= 2 && f.fromTap === 'true' && !f.fromCut, `${w}: a tap shows the whole question: ` + JSON.stringify(f));
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-from').click(); true`);
            f = await read(); assert.ok(f.fromLines <= 1 && f.fromTap === 'false', `${w}: and another puts it back to one line`);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
        }
    } finally { await client.close(); }
    console.log('artifact_viewer_sandbox_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
