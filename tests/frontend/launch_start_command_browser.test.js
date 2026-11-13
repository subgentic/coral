// #15951 (the Operator's ask): New agent shows the agent's exact start command before Launch, read off the server's own launch builder (POST /api/launch/permission-args answers `command`), with Coral's own values as
// <placeholders>, a Copy button, and on a phone one line with "Show full command". It follows the choices. Isolated dev server at 1440 and 390 px, light and dark. Screenshots with CORAL_SCREENSHOT_DIR.
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
            // the note under the line, and the reason in place of a line that could not be built (#16052)
            const extra = await ev(`(async () => { const note = document.querySelector('#launch-recap .launch-recap-command .lrc-note')?.textContent || ''; const m = await import((window.__coralStatic || '/static/') + 'permission_flags_line.js'); const n = m.flagsNodes({ args: [], text: '', command: '', command_error: 'the agent home could not be made' }, 'claude'); return { note, err: n.map(x => x.className + ': ' + x.textContent).join(' | ') }; })()`);
            if (!/shown as typed/.test(extra.note)) problems.push(label + ': no note about values typed after a flag: ' + JSON.stringify(extra.note));
            if (!/launch-recap-command-error: Start command: could not be built. the agent home could not be made/.test(extra.err)) problems.push(label + ': a failed build does not show its reason: ' + extra.err);
            // read-only and labelled
            const g = await ev(`(() => { const r = document.querySelector('#launch-recap .launch-recap-command'); if (!r) return null; const b = [...r.querySelectorAll('button')].map(x => ({ t: x.textContent.trim(), shown: x.getClientRects().length > 0 })); return { label: r.querySelector('.lrc-label').textContent, buttons: b, editable: !!r.querySelector('input,textarea,[contenteditable]') }; })()`);
            if (!g) problems.push(label + ': no start command row'); else {
                if (g.label !== 'Start command' || g.editable) problems.push(label + ': the row is not a read-only "Start command": ' + JSON.stringify(g));
                const copy = g.buttons.find(x => x.t === 'Copy'), more = g.buttons.find(x => x.t === 'Show full command');
                if (!copy || !copy.shown) problems.push(label + ': no Copy button');
                if (mobile && !(more && more.shown)) problems.push(label + ': a phone has no Show full command');
                if (!mobile && more && more.shown) problems.push(label + ': Show full command is shown on a wide screen');
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
                if (mobile) {
                    const one = await ev(`(() => { const t = document.querySelector('#launch-recap .lrc-text'); const cs = getComputedStyle(t); return { nowrap: cs.whiteSpace === 'nowrap', cut: t.scrollWidth > t.clientWidth, h: t.getBoundingClientRect().height }; })()`);
                    if (!one.nowrap || !one.cut) problems.push(`${label}/${theme}: the line is not collapsed to one: ${JSON.stringify(one)}`);
                }
                await shot(`start-command-${label}-${theme}`);
            }
            if (mobile) {
                await ev(`document.querySelector('#launch-recap .lrc-more').click(); true`);
                const open = await ev(`(() => { const m = document.querySelector('#launch-recap .lrc-more'), t = document.querySelector('#launch-recap .lrc-text'); return { expanded: m.getAttribute('aria-expanded'), label: m.textContent.trim(), wraps: getComputedStyle(t).whiteSpace !== 'nowrap', fits: ${fits} }; })()`);
                if (open.expanded !== 'true' || open.label !== 'Show less' || !open.wraps || !open.fits) problems.push('390: Show full command does not open the whole line: ' + JSON.stringify(open));
                await shot('start-command-390-open');
            }
            console.log(`   ${label} done`);
        }
        assert.deepEqual(problems, [], problems.join('\n'));
        console.log('PASS New agent: the start command, read off the launch builder, with Copy, collapsed on a phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
