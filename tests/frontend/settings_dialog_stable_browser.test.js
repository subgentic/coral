// The Settings dialog is one size that never moves between its tabs, and one type scale (#7405, UI/UX's Settings proposal): 960 x 720 on a desktop whatever the tab, the header, the tab list and the footer in the
// same place, only the body scrolls; every visible text in it is Plus Jakarta Sans in one of eight sizes and weights. Measured on every tab at 1280 x 900, 100% text, and the font census over every tab.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { framesJs } = require('./helpers/wait');

// family, size px, weight: the dialog title, pane title, section heading, nav tab and its selected one, row label, control and button, hint, badge
const SCALE = new Set(['16/700', '17/700', '14/600', '14/400', '13/500', '13/400', '12/400', '11/600']);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const report = process.env.CDP_FULL === '1';
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }); await Emulation.setTouchEmulationEnabled({ enabled: false });
        await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`const st = document.createElement('style'); st.textContent = '* { transition: none !important; animation: none !important }'; document.head.appendChild(st); window.showSettingsModal(); true`); // a weight or size caught mid-transition is no style
        await waitFor(`!!document.getElementById('settings-modal') && document.getElementById('settings-modal').getClientRects().length > 0 && document.querySelectorAll('#settings-tabs [role="tab"]').length > 3`, 'the dialog and its tabs', 10000);
        const tabs = await ev(`[...document.querySelectorAll('#settings-tabs [role="tab"]')].filter(t => t.getClientRects().length).map(t => t.id)`);
        assert.ok(tabs.length >= 7, 'the tabs: ' + tabs.join(', '));
        // the ring (quiet_focus.js, the same file as #7391's): Settings opened with no input at all (a script) shows it, as the browser would; opened a moment after a pointer press it shows none on what took the
        // focus, and the first key press brings it back
        const ringOf = () => ev(`({ marked: document.getElementById('settings-modal').hasAttribute('data-quiet-focus'), inDialog: document.getElementById('settings-modal').contains(document.activeElement), ring: (a => a ? getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth : '')(document.activeElement) })`);
        // the dialog moves focus in one frame after it shows (dialog_focus.js): wait for it, so a slow frame is not read as focus left outside (#7612)
        await waitFor(`document.getElementById('settings-modal').contains(document.activeElement)`, 'Settings opened by a script: focus moves into it', 10000);
        const scripted = await ringOf();
        assert.ok(!scripted.marked && scripted.inDialog, 'Settings opened by a script (no input): focus is in it and the ring is not suppressed: ' + JSON.stringify(scripted));
        await ev(`window.hideSettingsModal(); true`);
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }); await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`document.getElementById('settings-modal').getClientRects().length > 0 && !!document.querySelector('#settings-modal .settings-pane:not([hidden])')`, 'Settings opened after a click', 10000);
        await waitFor(`document.getElementById('settings-modal').contains(document.activeElement)`, 'Settings opened after a click: focus moves into it', 10000);
        const pointer = await ringOf();
        assert.ok(pointer.marked && pointer.inDialog && /^none |^[a-z]+ 0px$/.test(pointer.ring), 'Settings opened just after a click: focus is in it and wears no ring: ' + JSON.stringify(pointer));
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await ev(framesJs(2));
        assert.equal(await ev(`document.getElementById('settings-modal').hasAttribute('data-quiet-focus')`), false, 'the first key press lifts the quiet start (the ring comes with the keyboard)');
        const rect = () => ev(`(() => { const r = e => { const b = document.querySelector(e).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { dialog: r('.settings-modal-content'), header: r('#settings-modal .modal-header'), nav: r('#settings-modal .settings-nav'), footer: r('#settings-modal .modal-footer') }; })()`);
        const fonts = () => ev(`(() => { const out = {}; const dlg = document.querySelector('.settings-modal-content'); const w = document.createTreeWalker(dlg, NodeFilter.SHOW_TEXT);
            const seen = new Set(); for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const e = n.parentElement; if (!e || seen.has(e) || !e.getClientRects().length) continue; seen.add(e); const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
                if (/Material Icons/.test(cs.fontFamily)) continue; /* icon glyphs */ const k = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() + ' ' + parseFloat(cs.fontSize) + '/' + cs.fontWeight; (out[k] = out[k] || []).push((e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')) + ': ' + n.textContent.trim().slice(0, 24)); }
            for (const e of dlg.querySelectorAll('input, select, textarea')) { if (!e.getClientRects().length) continue; const cs = getComputedStyle(e); const k = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim() + ' ' + parseFloat(cs.fontSize) + '/' + cs.fontWeight + ' (control)'; (out[k] = out[k] || []).push((e.id ? '#' + e.id : e.tagName.toLowerCase())); }
            return out; })()`);
        const rects = {}, bad = {};
        for (const id of tabs) {
            await ev(`document.getElementById('${id}').click(); true`); await ev(framesJs(3));
            rects[id] = await rect();
            if (process.env.CORAL_SCREENSHOT_DIR) { const fs = require('node:fs'); fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(require('node:path').join(process.env.CORAL_SCREENSHOT_DIR, 'settings-' + id.replace('settings-tab-', '') + '.png'), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const f = await fonts();
            for (const [k, els] of Object.entries(f)) { const m = /^(.*) ([\d.]+\/\d+)( \(control\))?$/.exec(k) || [k, k, k]; if (m[1] !== 'Plus Jakarta Sans' || !SCALE.has(m[2])) (bad[k] = bad[k] || []).push(...els.slice(0, 3).map(e => id.replace('settings-tab-', '') + ' ' + e)); }
        }
        if (report) { console.log(JSON.stringify(rects)); console.log(Object.entries(bad).map(([k, v]) => `${k} x${v.length}: ${v.slice(0, 4).join(' | ')}`).join('\n')); }
        const first = rects[tabs[0]];
        assert.deepEqual(first.dialog.slice(2), [960, 720], 'the dialog is 960 x 720 on a 1280 x 900 window');
        for (const id of tabs) assert.deepEqual(rects[id], first, `${id}: the dialog, its header, tab list and footer are where they are on every other tab`);
        assert.equal(Object.keys(bad).length, 0, 'texts outside the scale (family size/weight): ' + Object.entries(bad).map(([k, v]) => `${k} x${v.length} ${v[0]}`).join('; '));
        // round 2 (UI/UX's #7405 notes): the rows are finished
        const rows2 = {};
        for (const id of tabs) {
            await ev(`document.getElementById('${id}').click(); true`); await ev(framesJs(3));
            rows2[id] = await ev(`[...document.querySelectorAll('#settings-modal .settings-pane:not([hidden]) .settings-row')].filter(r => r.getClientRects().length).map(r => { const l = r.querySelector('.settings-learn'), h = [...r.querySelectorAll('.settings-hint-line')].some(x => x.getClientRects().length); const dt = r.querySelector('dt'); return { label: (dt && (dt.querySelector('label, span') || dt).textContent.trim().slice(0, 28)) || '', learnWithoutHint: !!l && l.getClientRects().length > 0 && !h }; })`);
        }
        const NEED_A_LINE = ['Default thinking', 'Default models', 'Fit pane width', 'Free space', 'Automatic cleanup', 'Artifact store limit', 'Received files limit']; // the rows whose label alone does not say what they do (UI/UX's #7405 notes); the others' labels say it, and their Learn more stands alone
        const bare = Object.entries(rows2).flatMap(([t, rs]) => rs.filter(r => r.learnWithoutHint && NEED_A_LINE.some(n => r.label.startsWith(n))).map(r => t.replace('settings-tab-', '') + ': ' + r.label));
        assert.deepEqual(bare, [], 'the five rows have their one-line hint beside Learn more');
        await ev(`document.getElementById('settings-tab-agents').click(); true`); await ev(framesJs(3));
        const perm = await ev(`(() => { const h = document.querySelector('#settings-pane-agents .perm-mode-desc').getBoundingClientRect(), s = document.getElementById('settings-permission-mode').getBoundingClientRect(), l = document.getElementById('settings-permission-mode-label').getBoundingClientRect(); return { underLabel: h.top >= l.bottom - 2 && h.left < s.left, name: document.querySelector('label[for="settings-permission-mode"]').id }; })()`);
        assert.deepEqual(perm, { underLabel: true, name: 'settings-permission-mode-label' }, 'the permission mode hint is under its label, on the left');
        const savedLine = await ev(`(async () => {
            const realFetch = window.fetch; window.fetch = (...a) => new Promise(r => setTimeout(r, 400)).then(() => realFetch(...a)); // sleep-ok: a slow machine's answers, so the dialog is filled long after three frames
            const st = window.__coralStatic || '/static/'; const { state } = await import(st + 'state.js'); const out = {};
            for (const [k, v] of [['unset', undefined], ['saved auto', 'auto'], ['saved default', 'default']]) {
                window.hideSettingsModal(); if (v === undefined) delete state.settings.default_permission_mode; else state.settings.default_permission_mode = v;
                await window.showSettingsModal('agents'); await ${framesJs(3)}; // it returns once the dialog is filled (it awaits its requests): three frames alone read it half-filled on a slow machine (the Windows failure, #7571)
                const sel = document.getElementById('settings-permission-mode'); out[k] = [sel.value, sel.closest('.sv-row').querySelector('.perm-mode-warn').getBoundingClientRect().height > 0];
            }
            window.fetch = realFetch; return out; })()`);
        assert.deepEqual(savedLine, { unset: ['', false], 'saved auto': ['auto', true], 'saved default': ['default', false] }, 'the line follows the SAVED mode: a fresh install (nothing saved, the select reads Not set) refuses nothing and shows no line (Security, #7587)');
        const ANY = 'Agents cannot start workers in this mode.';
        const warnState = await ev(`(() => { const sel = document.getElementById('settings-permission-mode'), row = sel.closest('.sv-row'), warn = row.querySelector('.perm-mode-warn'), learn = row.querySelector('.sv-learn'), out = {}; const shown = () => warn.getBoundingClientRect().height > 0;
            for (const m of ['plan', 'bypassPermissions', 'default', 'dontAsk', 'acceptEdits', 'auto']) { sel.value = m; sel.dispatchEvent(new Event('change', { bubbles: true })); out[m] = shown() ? warn.textContent : null; }
            const more = document.getElementById(learn.getAttribute('aria-controls')); const closed = more.getBoundingClientRect().height === 0; learn.click(); return { out, text: warn.textContent, label: learn.getAttribute('aria-label'), closed, opened: more.getBoundingClientRect().height > 0, expanded: learn.getAttribute('aria-expanded'), more: more.textContent }; })()`);
        assert.deepEqual(warnState, { out: { plan: 'Claude agents cannot start workers in this mode.', bypassPermissions: ANY, default: null, dontAsk: ANY, acceptEdits: ANY, auto: ANY }, text: ANY, label: 'Show less about Default permission mode', closed: true, opened: true, expanded: 'true', more: "With such a default, an orchestrator's launches are refused until you pick Default or start them yourself." }, 'the default permission mode says workers cannot be started in every mode but Default (Plan: for Claude agents), the rule agent.SkipsPermissionPrompts refuses by; every mode has Learn more with the rule');
        await ev(`document.getElementById('settings-tab-cleanup').click(); true`); await ev(framesJs(3));
        const st = await ev(`(() => { const r = id => document.getElementById(id).getBoundingClientRect(); const days = r('settings-prune-days'), kind = r('settings-prune-kind'), shrink = r('settings-storage-shrink'), prune = r('settings-storage-prune');
            const det = document.getElementById('settings-storage-breakdown').getBoundingClientRect(), pane = document.getElementById('settings-pane-cleanup').getBoundingClientRect();
            return { free: { labelled: !!document.querySelector('label[for="settings-prune-days"]') && !!document.querySelector('label[for="settings-prune-kind"]'), stacked: kind.top >= days.bottom - 2, buttonsUnder: shrink.top >= kind.bottom - 2, oneRow: Math.abs(shrink.top - prune.top) < 6 }, breakdownWide: det.width > pane.width * 0.6 }; })()`);
        assert.deepEqual(st, { free: { labelled: true, stacked: true, buttonsUnder: true, oneRow: true }, breakdownWide: true }, 'Free space is two labelled fields and then Shrink and Prune on one row; By age and board has the full width');
        await ev(`document.getElementById('settings-tab-terminal').click(); true`); await ev(framesJs(3));
        const wake = await ev(`(() => { const w = document.getElementById('tb-autowake-on'); return w ? { switchLook: getComputedStyle(w).appearance === 'none', outsideCard: !w.closest('#settings-terminal-backend') } : null; })()`);
        if (wake) assert.deepEqual(wake, { switchLook: true, outsideCard: true }, 'Wake agents after a restart is a switch, outside the backend card');

        // the phone (the tab list becomes a Section selector) and 200% text on a desktop: the dialog is one rectangle on every section there too
        const pickAll = async (label, w, h, mobile, font) => {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await ev(`window.hideSettingsModal && window.hideSettingsModal(); document.documentElement.style.fontSize = ${JSON.stringify(font)}; window.showSettingsModal(); true`);
            await waitFor(`!!document.getElementById('settings-modal') && document.getElementById('settings-modal').getClientRects().length > 0 && !!document.querySelector('#settings-modal .settings-pane:not([hidden])')`, `${label}: the dialog`, 10000);
            const groups = await ev(`[...document.querySelectorAll('#settings-modal .settings-group-pick option')].map(o => o.value)`);
            const useSelect = mobile || await ev(`getComputedStyle(document.querySelector('#settings-modal .settings-group-pick')).display !== 'none'`);
            const at = {};
            for (const g of groups) {
                if (useSelect) await ev(`(() => { const s = document.querySelector('#settings-modal .settings-group-pick select'); s.value = ${JSON.stringify(g)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
                else await ev(`document.getElementById('settings-tab-${g}').click(); true`);
                await ev(framesJs(3));
                at[g] = await ev(`(() => { const r = e => { const b = document.querySelector(e).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }; return { dialog: r('.settings-modal-content'), header: r('#settings-modal .modal-header'), footer: r('#settings-modal .modal-footer') }; })()`);
            }
            if (process.env.CORAL_SCREENSHOT_DIR) for (const g of ['agents', 'terminal']) { await ev(`(() => { const s = document.querySelector('#settings-modal .settings-group-pick select'); if (s && getComputedStyle(s).display !== 'none') { s.value = ${JSON.stringify(g)}; s.dispatchEvent(new Event('change', { bubbles: true })); } else document.getElementById('settings-tab-${g}').click(); return true; })()`); await ev(framesJs(3)); require('node:fs').writeFileSync(require('node:path').join(process.env.CORAL_SCREENSHOT_DIR, `settings-${label.replace(/[^a-z0-9]+/gi, '-')}-${g}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const first = at[groups[0]];
            assert.ok(groups.length >= 7, `${label}: the sections: ${groups.join(', ')}`);
            for (const g of groups) assert.deepEqual(at[g], first, `${label}: ${g}: the dialog, its header and footer are where they are on every other section`);
            assert.ok(first.dialog[0] + first.dialog[2] <= w + 1 && first.dialog[1] + first.dialog[3] <= h + 1, `${label}: the dialog is inside the window: ${JSON.stringify(first.dialog)}`);
            if (report) console.log(label, JSON.stringify(first));
        };
        await pickAll('phone 390 px', 390, 844, true, '');
        await pickAll('phone 390 px at 200% text', 390, 844, true, '200%');
        await pickAll('desktop 1280 px at 200% text', 1280, 900, false, '200%');
        console.log('PASS settings dialog stable');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
