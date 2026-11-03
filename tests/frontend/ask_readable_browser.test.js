// #12518 / #12722: the complete question preserves line breaks and numbered steps, including
// inline lists; the title names the asker/team. Desktop and phone, isolated server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const FLAT = "@Operator Rotating do-r1-write.token, about 5 minutes in the DigitalOcean console: 1. API, Tokens: open the existing token behind do-r1-write.token and note its scopes and expiry. 2. Generate New Token: name coralhub-r1-write-2026-11-02, expiry 30 days, the SAME scopes as the old one. 3. Save the new value over ~/.config/coralhub/do-r1-write.token (keep mode 0600). 4. Delete the old token in the console. 5. Reply 'rotated', and say whether the old value was stored anywhere else.";
const LINES = '@Operator Which hub do we ship to?\nFirst line of detail.\nSecond line of detail, on its own line.\n\n- self-hosted\n- the hosted one';

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev);
            const at = `${w}: `;
            await ev(`(() => { window.__asks = [{ board: 'coral-hub', board_label: 'coral-hub', kind: 'ask', id: 41, asker: 'Orchestrator', text: ${JSON.stringify(FLAT)}, at: new Date(Date.now() - 7 * 60000).toISOString() }, { board: 'team', board_label: 'team', kind: 'ask', id: 42, asker: 'Dev', text: ${JSON.stringify(LINES)}, at: new Date(Date.now() - 3 * 60000).toISOString() }];
                const orig = window.fetch.bind(window); window.fetch = (u, o) => String(u) === '/api/operator-asks' ? Promise.resolve(new Response(JSON.stringify(window.__asks), { status: 200, headers: { 'Content-Type': 'application/json' } })) : orig(u, o); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 2`, at + 'two rows of Needs you', 10000);
            const read = () => ev(`(() => { const d = document.querySelector('dialog.inbox-ask-dialog'), b = d.querySelector('.inbox-ask-text'), r = d.getBoundingClientRect();
                return { title: d.querySelector('h2').textContent, items: [...b.querySelectorAll('ol > li')].map(l => l.textContent.trim().slice(0, 30)), bullets: b.querySelectorAll('ul > li').length, lead: (b.querySelector('p') || {}).textContent || '', pText: [...b.querySelectorAll('p')].map(p => p.innerText), pre: [...b.querySelectorAll('p')].map(p => getComputedStyle(p).whiteSpace), twice: d.querySelector('h2').textContent.length > 0 && b.textContent.includes(d.querySelector('h2').textContent) && b.textContent.indexOf(d.querySelector('h2').textContent) < 40, fits: r.left >= 0 && r.right <= innerWidth + 1, scrollsSideways: b.scrollWidth > b.clientWidth + 1 }; })()`);
            const closeIt = async () => { await ev(`document.querySelector('dialog.inbox-ask-dialog .inbox-ask-buttons .btn:not(.btn-primary)').click(); true`); await waitFor(`!document.querySelector('dialog.inbox-ask-dialog')`, at + 'Close closes it', 4000); };

            await ev(`document.querySelector('button[aria-label="Answer the question of Orchestrator"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the long question opens', 4000);
            const a = await read();
            assert.equal(a.title, 'Orchestrator · coral-hub', at + 'title names the asker and team');
            assert.equal(a.items.length, 5, at + 'five numbered steps are a list: ' + JSON.stringify(a.items));
            assert.ok(a.items[0].startsWith('API, Tokens') && a.items[4].startsWith("Reply 'rotated'"), at + 'in order: ' + JSON.stringify(a.items));
            assert.ok(!a.twice && !a.scrollsSideways && a.fits, at + 'the title is not said again in the body, and nothing runs past the edge: ' + JSON.stringify({ twice: a.twice, side: a.scrollsSideways, fits: a.fits }));
            await shot('ask-readable-flat-' + w);
            await closeIt();

            await ev(`document.querySelector('button[aria-label="Answer the question of Dev"]').click(); true`);
            await waitFor(`document.querySelector('dialog.inbox-ask-dialog[open]')`, at + 'the lines question opens', 4000);
            const b = await read();
            assert.equal(b.title, 'Dev · team', at + 'short question is in the body, title names the asker');
            assert.ok(b.pText[0].includes('First line of detail.\nSecond line of detail') && b.pre[0] === 'pre-line', at + "the asker's line break stays: " + JSON.stringify([b.pText[0], b.pre[0]]));
            assert.equal(b.bullets, 2, at + 'a bulleted list is a list');
            await shot('ask-readable-lines-' + w);
            await closeIt();
        }
        const parts = await ev(`import(${S} + 'operator_asks.js').then(m => ({ none: m.listsOf('See version 2.5 and 1. thing'), own: m.listsOf('a\\n1. b\\n2. c'), two: m.listsOf('Do: 1. one 2. two') }))`);
        assert.equal(parts.none, 'See version 2.5 and 1. thing', 'one number is not a list'); assert.equal(parts.own, 'a\n1. b\n2. c', 'text with its own breaks is left alone'); assert.equal(parts.two, 'Do:\n\n1. one\n2. two');
    } finally { await client.close(); }
    console.log('PASS a question keeps its lines, lists and title in Needs you');
})().catch(e => { console.error(e); process.exit(1); });
