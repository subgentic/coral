// Home's third card is New goal (#13012, the Operator: Open folder became New goal, and with no team the home has to say so). With a team: the card says what it does and opens the New goal screen on that team (a team
// choice when there are two). With no team: its line says there is no team yet, and pressing it explains and offers Start a team, never an empty goal form. At 1280, 390, and 390 at 200% text; the order of the three
// cards by keyboard; Open folder is not a Home card now and is still in the +New chooser. Drives Chrome over CDP through agent_view_harness.js.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const PLAIN = 'Give a team an outcome to work toward.';
const NONE = 'No team yet. Start one to give it a goal.';

(async () => {
    const { client, Page, Emulation, ev, waitFor, sleep, PRELOAD, install } = await connect();
    const results = [];
    const check = (label, cond, detail) => { results.push(!!cond); console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); await sleep(350); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }; // sleep-ok: a picture waits for the paint
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.addScriptToEvaluateOnNewDocument({ source: `(() => { const real = window.fetch; window.fetch = (u, o) => { try { const p = new URL(String(u), location.href); if (p.pathname === '/api/board/projects' && window.__teams) return Promise.resolve(new Response(JSON.stringify(window.__teams), { status: 200, headers: { 'content-type': 'application/json' } })); } catch (e) {} return real(u, o); }; })();` });
        const states = [['one team', [{ project: 'alpha' }]], ['two teams', [{ project: 'alpha' }, { project: 'beta' }]], ['no team', []]];
        for (const [w, h, mobile, big] of [[1280, 800, false, false], [390, 844, true, false], [390, 844, true, true]]) {
            for (const [what, teams] of states) {
                const tag = `${w}px${big ? ' 200%' : ''}, ${what}`;
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: 'about:blank' });
                await Page.addScriptToEvaluateOnNewDocument({ source: `window.__teams = ${JSON.stringify(teams)}; ${big ? "document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '32px'; });" : ''}` }).then(r => { global.__lastScript = r.identifier; });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
                await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
                const cardSel = mobile ? '.session-list li.empty-welcome .empty-launch' : '#welcome-screen .welcome-launch';
                await waitFor(`(() => { const d = document.querySelector('${mobile ? ".session-list li.empty-welcome [data-goal-desc]" : "#welcome-screen [data-goal-desc]"}'); return !!d && d.textContent === ${JSON.stringify(teams.length ? PLAIN : NONE)}; })()`, `the goal card's line for ${what}`, 8000);
                const cards = await ev(`[...document.querySelectorAll(${JSON.stringify(cardSel)})].filter(c => c.getClientRects().length).map(c => c.querySelector('strong').textContent + ' | ' + c.querySelector('span:not(.material-icons) span, strong + span').textContent)`);
                check(`${tag}: the three cards are New agent, New team, New goal; no Open folder`, cards.length === 3 && /^New agent/.test(cards[0]) && /^New team/.test(cards[1]) && cards[2] === `New goal | ${teams.length ? PLAIN : NONE}`, JSON.stringify(cards));
                // keyboard: the cards are buttons in that order
                const order = await ev(`(() => { const cs = [...document.querySelectorAll(${JSON.stringify(cardSel)})].filter(c => c.getClientRects().length); const all = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); const idx = cs.map(c => all.indexOf(c)); return { tag: cs.map(c => c.tagName), increasing: idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), height: cs.map(c => Math.round(c.getBoundingClientRect().height)), wide: cs.every(c => c.getBoundingClientRect().right <= innerWidth + 1) }; })()`);
                check(`${tag}: the cards are buttons in reading order, 44 px tall, inside the window`, order.tag.every(t => t === 'BUTTON') && order.increasing && order.height.every(v => v >= 44) && order.wide, JSON.stringify(order));
                if (!mobile && !big && what === 'one team') {
                    await ev(`window.showLaunchModal(); true`);
                    await waitFor(`(() => { const c = document.getElementById('launch-type-open-folder'); return !!c && c.getClientRects().length > 0; })()`, 'the chooser with Open folder', 8000).catch(() => {});
                    const folder = await ev(`({ card: !!document.getElementById('welcome-open-folder'), chooser: !!document.getElementById('launch-type-open-folder') && document.getElementById('launch-type-open-folder').getClientRects().length > 0 })`);
                    check(`${tag}: Open folder is not a Home card and is in the +New chooser`, !folder.card && folder.chooser, JSON.stringify(folder));
                    await ev(`window.hideLaunchModal(); true`);
                }
                console.log(`  pressing the card: ${tag}`);
                if (!big && (what === 'one team' || what === 'no team')) await shot(`home-after-${w}-${what.replace(' ', '-')}`);
                // press the card
                await ev(`[...document.querySelectorAll(${JSON.stringify(cardSel)})].filter(c => c.getClientRects().length)[2].click(); true`);
                if (teams.length) {
                    await waitFor(`!!document.querySelector('dialog.goal-editor[open]')`, 'the New goal screen', 8000);
                    const g = await ev(`(() => { const d = document.querySelector('dialog.goal-editor[open]'); const sel = document.getElementById('goal-new-team'); return { title: d.querySelector('#goals-create-title').textContent, select: !!sel, options: sel ? [...sel.options].map(o => o.textContent) : [], fixed: [...d.querySelectorAll('.goal-scope-fixed b')].map(b => b.textContent) }; })()`);
                    check(`${tag}: the card opens the New goal screen, on the team (one) or asking which (two)`, g.title === 'New goal' && (teams.length === 1 ? !g.select && g.fixed.join() === 'alpha' : g.select && g.options.length === 2), JSON.stringify(g));
                    await ev(`document.querySelector('dialog.goal-editor[open]').close(); true`);
                } else {
                    await waitFor(`(() => { const e = document.getElementById('confirm-modal'); return !!e && getComputedStyle(e).display !== 'none'; })()`, 'the no-team explanation', 8000);
                    const c = await ev(`(() => { const m = document.getElementById('confirm-modal'); const bs = [...m.querySelectorAll('.modal-actions .btn')].filter(b => b.getClientRects().length); return { title: document.getElementById('confirm-modal-title').textContent, msg: document.getElementById('confirm-modal-message').textContent, buttons: bs.map(b => b.textContent), primary: bs.map(b => b.classList.contains('btn-primary')), goalForm: !!document.querySelector('dialog.goal-editor[open]'), focus: document.activeElement && document.activeElement.textContent }; })()`);
                    check(`${tag}: no team: it explains and offers Start a team (Cancel first, the primary last), and opens no goal form`, c.title === 'No team to give a goal to' && /goal goes to a team/.test(c.msg) && c.buttons.join() === 'Cancel,Start a team' && c.primary.join() === 'false,true' && !c.goalForm, JSON.stringify(c));
                    await ev(`[...document.querySelectorAll('#confirm-modal .modal-actions .btn')].find(b => b.textContent === 'Start a team').click(); true`);
                    await waitFor(`(() => { const e = document.getElementById('launch-step-team'); return !!e && getComputedStyle(e).display !== 'none'; })()`, 'the New team step', 8000);
                    check(`${tag}: Start a team opens the New team flow`, true);
                }
            }
        }
    } finally { await client.close(); }
    const failed = results.filter(r => !r).length;
    console.log(`${results.length - failed} of ${results.length} checks passed`);
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
