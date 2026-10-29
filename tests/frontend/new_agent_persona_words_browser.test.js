// New agent step 2 (Persona) has only the words it needs (#10835, the operator: "a bit too much text"): the header says "Step 2 of 3: Persona, all optional" and no folder (the footer says it once), the select says
// once what it is for, the field has no "optional" tag each, no help line under Name and no "It fills in the name and prompt.", the Bypass warning in the footer is the short ⚠ form with the sentence as
// its hover, and the Name field is on screen without scrolling. A visible-word budget for the whole step. At 1280 and 390, with shots. Isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installNA, N, openNewAgent, stubModels } = require('./helpers/new_agent');
const BASE = require('./test_base').BASE;
const WORD_BUDGET = Number(process.env.PERSONA_WORD_BUDGET || 38);

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
            await ev(`(() => { const s = document.querySelector('.acf-permission-mode'), o = [...s.options].find(x => /Bypass/.test(x.textContent)); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`); // the operator's mode
            await ev(`new Promise(r => setTimeout(r, 600))`); // sleep-ok: the recap and the fields settle
            const r = await ev(`(() => { const dlg = window.__na.dialog(), vis = e => e.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true });
                let words = 0; const walk = n => { if (n.nodeType === 3) { if (n.textContent.trim() && vis(n.parentElement)) words += n.textContent.trim().split(/\\s+/).length; } else if (n.nodeType === 1 && vis(n)) for (const c of n.childNodes) walk(c); }; walk(dlg);
                const text = dlg.innerText, name = document.getElementById('launch-agent-name-input'), nr = name.getBoundingClientRect();
                const note = dlg.querySelector('.launch-recap-note');
                return { words, sub: document.getElementById('launch-stage-sub').textContent, optionalTags: [...dlg.querySelectorAll('.sv-optional, .launch-optional')].filter(vis).length, fills: /It fills in/.test(text), nameHelp: /goes here, or type your own/.test(text),
                    note: note && note.textContent, noteTitle: note && note.title, nameShown: nr.top >= 0 && nr.bottom <= innerHeight, wide: document.documentElement.scrollWidth <= innerWidth + 1 }; })()`);
            if (process.env.PERSONA_COUNT_FILE) fs.appendFileSync(process.env.PERSONA_COUNT_FILE, `${label}: ${r.words} visible words\n`);
            if (process.env.PERSONA_COUNT_ONLY) continue;
            assert.equal(r.sub, 'Step 2 of 3: Persona, all optional', `${label}: the title says all optional once, and no folder: ${r.sub}`);
            assert.equal(r.optionalTags, 0, `${label}: no optional tag on each field`);
            assert.equal(r.fills, false, `${label}: no "It fills in the name and prompt."`); assert.equal(r.nameHelp, false, `${label}: no help line under Name`);
            assert.ok(r.note && /^⚠ Isolated containers and VMs only\.$/.test(r.note) && /mode allows: everything except protected paths/.test(r.noteTitle), `${label}: the Bypass warning is the short form, the sentence is its hover: ${JSON.stringify([r.note, r.noteTitle])}`);
            assert.equal(r.nameShown, true, `${label}: Name is on screen without scrolling`); assert.equal(r.wide, true, `${label}: nothing is wider than the screen`);
            assert.ok(r.words <= WORD_BUDGET, `${label}: ${r.words} visible words, budget ${WORD_BUDGET}`);
            console.log(`${label}: ${r.words} visible words`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/persona-step-${label}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        }
        console.log('PASS');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
