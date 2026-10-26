// Settings on a phone (#5057, #7405): no row has an (i) now; its hint is a line under its label and a long one has a Learn more at 44 px. (Before: each row's (i) help button sat beside its label, at 44x44, not on a row of its own under it (that made a toggle's row 105 px instead of 80, and
// the General page about 50 px taller), and a switch's toggle is level with that (i) (#5109: the box sat at the top of its 44 px area, about 17 px above the (i)'s centre: the area is a label whose generic 12 px bottom margin was part of what got centred). Every section is checked at 390 px with a coarse pointer: wherever a row has an (i), it is level with the label and to its right.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setEmulatedMedia({ features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
        await Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 });
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        const l = Page.loadEventFired(); await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await l; await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`window.showSettingsModal().then(() => true)`);
        await waitFor(`(m => !!m && getComputedStyle(m).display !== 'none' && m.querySelectorAll('.settings-row, .sv-row').length > 3 && !!m.querySelector('.settings-group-pick select'))(document.getElementById('settings-modal'))`, 'Settings', 10000);
        const groups = await ev(`[...document.querySelector('#settings-modal .settings-group-pick select').options].map(o => o.value)`);
        assert.ok(groups.length >= 5, 'the sections: ' + JSON.stringify(groups));

        // #7405: no (i); a row's hint is a visible line under its label and a long one has a Learn more that is a real target. Measured per section.
        const rows = () => ev(`(() => { const out = []; const pane = '#settings-modal .settings-pane:not([hidden])';
            for (const row of document.querySelectorAll(pane + ' .settings-row')) { // the rows of a group that is not a settings_view yet
            if (!row.getClientRects().length) continue;
            const dt = row.querySelector('dt'), label = dt && dt.querySelector('label'); if (!label) continue;
            const hint = row.querySelector('.settings-hint-line'), learn = row.querySelector('.settings-learn'), l = label.getBoundingClientRect();
            const tog = row.querySelector(':scope > dd > .check-hit input'), tb = tog && tog.getBoundingClientRect();
            out.push({ label: label.textContent.trim().slice(0, 30), info: !!row.querySelector('.settings-info-btn'), hint: !!hint && hint.getClientRects().length > 0, under: !hint || !hint.getClientRects().length || hint.getBoundingClientRect().top >= l.bottom - 2, learnH: learn ? Math.round(Math.max(learn.getBoundingClientRect().height, parseFloat(getComputedStyle(learn, '::after').height) || 0)) : null, tog: tb ? tb.top < l.bottom && tb.bottom > l.top : null }); // the Hub's Learn more beside its sentence has its 44 px target in ::after too (#8276)
            }
            for (const row of document.querySelectorAll(pane + ' .sv-row')) { // the rows of a settings_view: its Learn more has its 44 px target in ::after
            if (!row.getClientRects().length) continue;
            const label = row.querySelector('.sv-label'); if (!label) continue;
            const text = row.querySelector('.sv-help-text'), learn = row.querySelector('.sv-learn'), l = label.getBoundingClientRect();
            const tog = row.querySelector('.sv-switch'), tb = tog && tog.getBoundingClientRect();
            const hintShown = !!text && text.textContent.trim() !== '' && text.getClientRects().length > 0;
            out.push({ label: label.textContent.trim().slice(0, 30), info: !!row.querySelector('.settings-info-btn'), hint: hintShown, under: !hintShown || text.getBoundingClientRect().top >= l.bottom - 2, learnH: learn ? Math.round(Math.max(learn.getBoundingClientRect().height, parseFloat(getComputedStyle(learn, '::after').height) || 0)) : null, tog: tb ? tb.top < l.bottom && tb.bottom > l.top : null });
            }
            return out; })()`);
        let seen = 0, general = 0, toggles = 0, learns = 0;
        for (const g of groups) {
            await ev(`(() => { const s = document.querySelector('#settings-modal .settings-group-pick select'); s.value = ${JSON.stringify(g)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
            await waitFor(`!!document.querySelector('#settings-modal .settings-pane:not([hidden])')`, 'the section ' + g, 4000);
            await new Promise(r => setTimeout(r, 200)); // sleep-ok: the pane lays out after it is shown
            for (const r of await rows()) {
                assert.equal(r.info, false, `${g}: no (i) on "${r.label}"`);
                assert.ok(r.under, `${g}: the hint is under its label "${r.label}", not beside it: ${JSON.stringify(r)}`);
                if (r.learnH !== null) { learns++; assert.ok(r.learnH >= 44, `${g}: Learn more on "${r.label}" is 44 px high or more: ${r.learnH}`); }
                if (r.tog !== null) { toggles++; assert.ok(r.tog, `${g}: the switch is on the line of its label "${r.label}": ${JSON.stringify(r)}`); }
                if (r.hint) seen++;
            }
            if (g === groups[0]) general = (await ev(`[...document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) .settings-row')].filter(r => r.getClientRects().length).reduce((a, r) => a + r.getBoundingClientRect().height, 0)`));
        }
        assert.ok(toggles >= 8, 'switch rows were checked against their labels: ' + toggles);
        assert.ok(seen >= 5, 'rows with a short hint line were checked across the sections: ' + seen);
        assert.ok(learns >= 3, 'Learn more links were checked: ' + learns);
        console.log('   General rows ' + Math.round(general) + ' px');
        if (process.env.CORAL_SCREENSHOT_DIR) { require('node:fs').mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); await ev(`(() => { const s = document.querySelector('#settings-modal .settings-group-pick select'); s.value = ${JSON.stringify(groups[0])}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); await new Promise(r => setTimeout(r, 300)); /* sleep-ok: the pane lays out after it is shown */ require('node:fs').writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/settings-phone-toggle-level.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
        console.log(`PASS ${seen} rows with a hint line under their labels (${toggles} switches level with their labels, ${learns} Learn more at 44 px) across ${groups.length} sections`);
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
