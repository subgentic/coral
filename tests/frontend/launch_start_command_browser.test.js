// #15951 (the Operator's ask): New agent shows the agent's exact start command before Launch, read off the server's own launch builder (POST /api/launch/permission-args answers `command`), with Coral's own values as
// <placeholders>, a Copy button, and a Start command disclosure at every width. It follows the choices. Isolated dev server at 1440 and 390 px, light and dark. Screenshots with CORAL_SCREENSHOT_DIR.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { coralReady } = require('./helpers/wait');
const { setTheme } = require('./helpers/contrast');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { install: installNA, stubModels, stubCliChecks } = require('./helpers/new_agent');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1440', 1440, 900, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev); await installNA(ev);
            await stubModels(ev); await stubCliChecks(ev, []);
            await ev(`(async () => { await window.showLaunchModal(); const c = document.querySelector('#launch-step-chooser [data-arg="agent"]'); if (c && c.getClientRects().length) c.click(); return true; })()`);
            await waitFor(`!!document.getElementById('launch-dir') && document.getElementById('launch-dir').getClientRects().length > 0`, 'the folder step', 8000);
            await ev(`(() => { const i = document.getElementById('launch-dir'); if (!i.value) { i.value = '/tmp'; i.dispatchEvent(new Event('input', { bubbles: true })); } document.getElementById('launch-agent-next').click(); return true; })()`);
            await waitFor(`document.getElementById('launch-agent-pick') && document.getElementById('launch-agent-pick').dataset.probed === '1'`, 'the cards', 10000);
            await ev(`(() => { for (let i = 0; i < 2; i++) { if (document.getElementById('launch-modal').getAttribute('data-agent-stage') !== 'agent') document.getElementById('launch-agent-next').click(); } return true; })()`); // to the model step: the recap is on that one only (#18568)
            await waitFor(`document.getElementById('launch-modal').getAttribute('data-agent-stage') === 'agent'`, 'the model step', 6000);
            const pick = (type, mode) => ev(`(() => { const t = document.querySelector('#launch-agent-acf .acf-agent-type'); t.value = ${JSON.stringify(type)}; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)
                .then(() => ev(`(() => { const m = document.querySelector('#launch-agent-acf .acf-permission-mode'); m.value = ${JSON.stringify(mode)}; m.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`));
            const cmd = () => ev(`document.querySelector('#launch-recap .launch-recap-command .lrc-text')?.textContent || ''`);
            const expectCmd = async (type, mode, has, hasNot = []) => {
                try {
                    await pick(type, mode);
                    await waitFor(`(document.querySelector('#launch-recap .launch-recap-command .lrc-text')?.textContent || '').includes(${JSON.stringify(has)})`, `${label} ${type}/${mode}: the start command has ${has}`, 6000);
                    const t = await cmd();
                    for (const bad of hasNot) if (t.includes(bad) || new RegExp(bad).test(t)) problems.push(`${label} ${type}/${mode}: the start command shows ${bad}: ${t}`);
                    if (/coral-hook-|\b[0-9a-f]{32,}\b|sk-[A-Za-z0-9_-]{16,}/.test(t)) problems.push(`${label} ${type}/${mode}: a Coral-internal value is in the line: ${t}`);
                } catch (e) { problems.push(e.message.slice(0, 300)); }
            };
            await expectCmd('codex', 'plan', '--sandbox read-only');
            await expectCmd('codex', 'bypassPermissions', '--dangerously-bypass-approvals-and-sandbox', ['--sandbox read-only']);
            await expectCmd('claude', 'plan', '--permission-mode plan');
            { // the recap is one line with an arrow at every width (#18568); its details (the command with Copy) open upward
                const c = await ev(`(() => { const t = document.getElementById('launch-recap-toggle'), r = document.getElementById('launch-recap'); return { shown: t.getClientRects().length > 0, closed: !r.hasAttribute('data-open'), cmdShown: !!document.querySelector('#launch-recap .launch-recap-command')?.getClientRects().length, expanded: t.getAttribute('aria-expanded') }; })()`);
                if (!c.shown || !c.closed || c.cmdShown || c.expanded !== 'false') problems.push(label + ': the recap is not one line with its toggle closed: ' + JSON.stringify(c));
                await shot(`recap-closed-${label}`); // the one line with its arrow (#18568)
                await ev(`document.getElementById('launch-recap-toggle').click(); true`);
                if ((await ev(`document.getElementById('launch-recap-toggle').getAttribute('aria-expanded')`)) !== 'true') problems.push(label + ': the toggle does not open the details');
            }
            // read-only and labelled
            const g = await ev(`(() => { const r = document.querySelector('#launch-recap .launch-recap-command'); if (!r) return null; const b = [...r.querySelectorAll('button')].map(x => ({ t: x.textContent.trim(), shown: x.getClientRects().length > 0 })); return { label: r.querySelector('.lrc-label').textContent, buttons: b, editable: !!r.querySelector('input,textarea,[contenteditable]') }; })()`);
            if (!g) problems.push(label + ': no start command row'); else {
                if (g.label !== 'Start command' || g.editable) problems.push(label + ': the row is not a read-only "Start command": ' + JSON.stringify(g));
                const copy = g.buttons.find(x => x.t === 'Copy'), more = g.buttons.find(x => x.t === 'Start command');
                if (!copy || !copy.shown) problems.push(label + ': no Copy button');
                if (!(more && more.shown)) problems.push(label + ': no Start command disclosure');
            }
            // Copy puts exactly the line on the clipboard
            await ev(`window.__copied = null; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); } catch {} true`);
            await ev(`document.querySelector('#launch-recap .lrc-copy').click(); true`);
            try { await waitFor(`window.__copied !== null`, 'the copy', 4000); const [copied, line] = [await ev(`window.__copied`), await cmd()]; if (copied !== line) problems.push(`${label}: Copy gave ${JSON.stringify(copied)}, the line says ${JSON.stringify(line)}`); } catch (e) { problems.push(label + ': ' + e.message.slice(0, 200)); }
            const fits = `document.documentElement.scrollWidth <= window.innerWidth + 1`;
            for (const theme of ['light', 'dark']) {
                await setTheme(ev, theme);
                if (!(await ev(fits))) problems.push(`${label}/${theme}: the page scrolls sideways`);
                const vis = await ev(`(() => { const row = document.querySelector('#launch-recap .launch-recap-command'), rec = document.getElementById('launch-recap'), a = row.getBoundingClientRect(), b = rec.getBoundingClientRect(); return { inRecap: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, inViewport: a.bottom <= window.innerHeight + 1 && a.top >= 0, w: a.width }; })()`);
                if (!vis.inRecap || !vis.inViewport) problems.push(`${label}/${theme}: the start command row is cut off or off screen: ` + JSON.stringify(vis));
                if (await ev(`!!document.querySelector('#launch-recap .lrc-text').getClientRects().length`)) problems.push(label + ': command is not collapsed by default');
                await shot(`start-command-${label}-${theme}`);
            }
            {
                await ev(`document.querySelector('#launch-recap .lrc-more').click(); true`);
                const open = await ev(`(() => { const m = document.querySelector('#launch-recap .lrc-more'), t = document.querySelector('#launch-recap .lrc-text'); return { expanded: m.getAttribute('aria-expanded'), label: m.textContent.trim(), wraps: getComputedStyle(t).whiteSpace !== 'nowrap', fits: ${fits} }; })()`);
                if (open.expanded !== 'true' || open.label !== 'Start command' || !open.wraps || !open.fits) problems.push(label + ': Start command does not open the whole line: ' + JSON.stringify(open));
                await shot('start-command-' + label + '-open');
            }
            // #18568 (the Operator, rc3): the recap and the start command belong to the model step only: going back, the persona and folder steps have none
            const seen = {};
            for (let i = 0; i < 3; i++) {
                const st = await ev(`(() => ({ stage: document.getElementById('launch-modal').getAttribute('data-agent-stage'), shown: document.getElementById('launch-recap').getClientRects().length > 0 }))()`);
                seen[st.stage] = st.shown;
                if (st.stage === 'folder') break;
                await ev(`document.getElementById('launch-agent-back').click(); true`);
            }
            if (seen.agent !== true || seen.persona !== false || seen.folder !== false) problems.push(label + ': the recap is not on the model step only: ' + JSON.stringify(seen));
            console.log(`   ${label} done`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent: the start command, read off the launch builder, with Copy, collapsed at every width');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
