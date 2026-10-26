// Settings at 200% text (#8277): every group, at 1280 and at 390 px with the text doubled (root font-size 32px), plus Network and Hub and Updates in hub mode.
// In each pane no control is clipped by its own container, runs past the dialog's edge, or sits on top of another control; the pane never scrolls sideways.
// Drives Chrome over CDP through agent_view_harness.js against an isolated dev server; run_cdp_suites.mjs finds it by name. A shot of each pane goes to CORAL_SCREENSHOT_DIR, else RUNNER_TEMP/out/shots (what the gate uploads).
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

// what is wrong with the open pane, as plain data
const SCAN = `(() => {
    const modal = document.getElementById('settings-modal');
    const pane = [...modal.querySelectorAll('.settings-pane')].find(p => !p.hidden);
    if (!pane) return { missing: true };
    const closedDetails = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open && !e.closest('summary')) return true; return false; }; // a closed disclosure's content is not drawn: its boxes are not on the screen
    const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const name = e => (e.getAttribute('aria-label') || e.textContent || e.id || e.className || e.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 40);
    const controls = [...pane.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea, [role=switch], [role=button]')].filter(e => vis(e) && !e.closest('[hidden]') && !closedDetails(e));
    const content = modal.querySelector('.modal-content').getBoundingClientRect();
    const scroller = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p); if (/(auto|scroll)/.test(o.overflowY) || /(auto|scroll)/.test(o.overflowX)) return p; } return null; };
    const out = { sideways: [], beyond: [], clipped: [], overlap: [], n: controls.length };
    for (const sc of [pane, modal.querySelector('.settings-panes'), modal.querySelector('.modal-body')].filter(Boolean)) if (sc.scrollWidth > sc.clientWidth + 1) out.sideways.push((sc.className || sc.id) + ' ' + sc.scrollWidth + '>' + sc.clientWidth);
    for (const e of controls) {
        const r = e.getBoundingClientRect();
        if (r.right > content.right + 1 || r.left < content.left - 1) out.beyond.push(name(e) + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + '] in [' + Math.round(content.left) + ',' + Math.round(content.right) + ']');
        // clipped by an ancestor that hides overflow (not a scroller): the control's box leaves that ancestor sideways
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
            const o = getComputedStyle(p);
            if (/(hidden|clip)/.test(o.overflowX) && !/(auto|scroll)/.test(o.overflowX)) { const pr = p.getBoundingClientRect(); if (r.right > pr.right + 1 || r.left < pr.left - 1) { out.clipped.push(name(e) + ' by ' + (p.className || p.tagName)); break; } }
        }
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        if (a.contains(b) || b.contains(a) || a.closest('label') === b.closest('label') && a.closest('label')) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 3 && h > 3) out.overlap.push(name(a) + ' / ' + name(b) + ' ' + Math.round(w) + 'x' + Math.round(h));
    }
    return out;
})()`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = require('./helpers/scene_shots')(Page);
    const findings = [];
    let allGroups = [];
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [label, w, h, mobile, hub] of [['1280', 1280, 800, false, false], ['390', 390, 844, true, false], ['hub-1280', 1280, 800, false, true], ['hub-390', 390, 844, true, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
            await require('./helpers/wait').bind(ev).coralReady('startup', 'settings');
            await ev(`document.documentElement.style.fontSize = '32px'; ${hub ? "document.body.classList.add('cloud-mode');" : ''} (async () => { await window.showSettingsModal('general'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'Settings', 10000);
            if (hub) await ev(`(async () => { (await import((window.__coralStatic || '/static/') + 'cloud_settings.js')).applyCloudSettingsDialog(); return true; })()`);
            // the groups come from the plain dialog; the hub's dialog is walked on the two panes it changes
            const listed = await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].map(t => t.id.replace('settings-tab-', ''))`);
            if (!hub) allGroups = listed;
            assert.ok(allGroups.length >= 8, `${label}: the groups are listed (${allGroups}; the dialog has ${listed})`);
            // in hub mode a group whose rows are all machine settings is empty and its tab hidden: walk the groups the hub dialog still shows (Network and Hub and Updates are the ones its changes touch)
            const shown = hub ? await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]:not([hidden])')].map(t => t.id.replace('settings-tab-', ''))`) : allGroups;
            if (hub && process.env.WALK_LOG) fs.appendFileSync(process.env.WALK_LOG, `${label} groups shown by the hub dialog: ${shown}\n`);
            const groups = hub ? shown.filter(g => g === 'network' || g === 'updates' || g === 'general') : allGroups;
            assert.ok(!hub || groups.length > 0, `${label}: the hub dialog shows a group to walk (${shown})`);
            for (const g of groups) {
                await ev(`(async () => { await window.showSettingsModal(${JSON.stringify(g)}); return true; })()`);
                await waitFor(`[...document.querySelectorAll('#settings-modal .settings-pane')].some(p => !p.hidden && p.dataset.group === ${JSON.stringify(g)})`, `${label}: the ${g} pane`, 10000);
                if (hub) await ev(`(async () => { (await import((window.__coralStatic || '/static/') + 'cloud_settings.js')).applyCloudSettingsDialog(); return true; })()`);
                const r = await ev(SCAN);
                await shot(`settings-200-${label}-${g}`);
                if (r.missing) { findings.push(`${label} ${g}: no pane shown`); continue; }
                for (const k of ['sideways', 'beyond', 'clipped', 'overlap']) if (r[k].length) findings.push(`${label} ${g} ${k}: ${r[k].slice(0, 5).join('; ')}`);
                if (process.env.WALK_LOG) fs.appendFileSync(process.env.WALK_LOG, `${label} ${g}: ${r.n} controls ${JSON.stringify(r)}\n`);
                // the same pane with every disclosure open: what a person sees after opening Change password or the CLI paths
                await ev(`[...document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) details')].forEach(d => { d.open = true; }); true`);
                const ro = await ev(SCAN);
                for (const k of ['sideways', 'beyond', 'clipped', 'overlap']) if (ro[k].length) findings.push(`${label} ${g} (disclosures open) ${k}: ${ro[k].slice(0, 5).join('; ')}`);
                await shot(`settings-200-${label}-${g}-open`);
                await ev(`[...document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) details')].forEach(d => { d.open = false; }); true`);
            }
        }
        assert.deepEqual(findings, [], 'Settings at 200% text:\n' + findings.join('\n'));
        console.log('PASS Settings at 200% text: no clipped, overlapping or unreachable control in any group');
    } finally { await client.close(); }
})().catch(e => { console.error(e.message || e); process.exit(1); });
