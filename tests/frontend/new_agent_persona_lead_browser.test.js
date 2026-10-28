// New agent step 2 says what a persona is first (#9998 point 3, the phone triage): the sentence "A persona is a saved name and prompt. Pick one, or skip." is above the select, and
// Save as persona, Export personas and Import personas are one More menu on the select's row (closed at first). At 1280 and 390, with shots. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installNA(ev); await stubModels(ev);
            await ev(`localStorage.setItem('coral-recent-dirs', JSON.stringify(['/work/payments-app'])); true`);
            await openNewAgent(ev, waitFor);
            await ev(`(() => { const e = window.__na.find('input', ${N.folder}); e.value = '/work/payments-app'; e.dispatchEvent(new Event('input', { bubbles: true })); window.__na.find('button', ${N.next}).click(); return true; })()`);
            await waitFor(`/Step 2 of 3/.test(window.__na.dialog().textContent)`, `${label}: step 2`, 6000);
            const r = await ev(`(() => { const top = document.getElementById('launch-persona-top'); const lead = top.querySelector('.launch-persona-lead'), sel = top.querySelector('select');
                const vis = e => !!e && e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); const d = top.querySelector('details.persona-files');
                return { lead: lead && lead.textContent.trim(), leadAbove: !!lead && !!sel && !!(lead.compareDocumentPosition(sel) & Node.DOCUMENT_POSITION_FOLLOWING), more: d && d.querySelector('summary').textContent.trim(), open: d && d.open,
                    inMenu: d ? [...d.querySelectorAll('button')].map(b => b.textContent.trim()) : [], shownClosed: ['#agent-save-persona-btn', '[data-on-click="m-export-personas"]'].map(q => vis(top.querySelector(q))), sameRow: !!d && d.closest('.launch-persona-row') === sel.closest('.launch-persona-row'),
                    wide: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
            assert.equal(r.lead, 'A persona is a saved name and prompt. Pick one, or skip.', `${label}: the sentence`);
            assert.equal(r.leadAbove, true, `${label}: it is above the select`);
            assert.equal(r.more, 'More', `${label}: one More menu`); assert.equal(r.open, false, `${label}: closed at first`);
            assert.deepEqual(r.inMenu, ['Save as persona', 'Export personas', 'Import personas'], `${label}: its three actions`);
            assert.deepEqual(r.shownClosed, [false, false], `${label}: none of them shows while it is closed`);
            assert.equal(r.sameRow, true, `${label}: on the select's row`); assert.equal(r.wide, true, `${label}: nothing is wider than the screen`);
            // opened: Save as persona is the one clear action, with Export and Import under it as a quieter pair on one line (#10286)
            await ev(`document.querySelector('#launch-persona-top details.persona-files summary').click(); true`);
            const g = await ev(`(() => { const top = document.getElementById('launch-persona-top'), r = q => { const e = top.querySelector(q); return e && e.getBoundingClientRect(); };
                const save = r('#agent-save-persona-btn'), exp = r('[data-on-click="m-export-personas"]'), imp = r('[data-on-click="m-import-personas"]'); if (!save || !exp || !imp) return null;
                const sub = top.querySelector('.persona-files-sub'); const fs = q => parseFloat(getComputedStyle(top.querySelector(q)).fontSize);
                return { saveAbove: save.bottom <= exp.top + 1 && save.bottom <= imp.top + 1, oneLine: Math.abs(exp.top - imp.top) <= 2, side: imp.left >= exp.right - 1, sub: !!sub && sub.contains(top.querySelector('[data-on-click="m-export-personas"]')) && sub.contains(top.querySelector('[data-on-click="m-import-personas"]')),
                    quieter: top.querySelector('[data-on-click="m-export-personas"]').classList.contains('btn-quiet') && !top.querySelector('#agent-save-persona-btn').classList.contains('btn-quiet') }; })()`);
            assert.ok(g, `${label}: the three actions show when it is open`);
            assert.deepEqual([g.saveAbove, g.oneLine, g.side, g.sub, g.quieter], [true, true, true, true, true], `${label}: Save as persona, then Export and Import under it on one line, quieter: ${JSON.stringify(g)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/new-agent-step2-${label}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
        console.log('\nPASS New agent step 2: the sentence first, one More menu');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
