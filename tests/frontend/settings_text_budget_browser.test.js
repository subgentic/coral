// How much text each Settings group shows before anything is opened (the usability pass, #5985: "help people get to the setting, then expand it with more info if necessary"). The words a person
// can see in a group are counted (text nodes whose whole path is shown; a select's options are not text); a group that has been cut has a budget, so a paragraph that creeps back fails here. The
// long explanations are behind each row's (i): a button with aria-expanded that controls its text, and the text still describes its control. Read as a computer connected to Coral Hub at Launch, with
// every Hub row shown (the largest the Network and Hub group gets). What the server holds is stood in for too: no terminal logs and no kept worktrees (a suite that ran before on the same server leaves a log of an ended agent, which adds its row's words). Drives Chrome over CDP against the isolated dev server; the cloud routes are stood in for the page's fetch.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

// words a person can see in a group now, per the audit (artifact 141071b6); a group with no number has not been cut yet
// #10191: Agents 142 to 153 (+11): Settings' hint under Default permission mode no longer says Auto has safety checks for every CLI ('Everything; safety checks on Claude only.', +2 words), and #10000's one line under Default permission mode (13 words: Default asks, Auto acts on its own, Not set uses Auto; what Auto is on each CLI is behind its Learn more) and the closed CLI paths row's note (3), less what left with the Default models' placeholders, which became dropdowns; a feature's own lines, within UI/UX's about 150 for Agents.
const BUDGET = { 'Network and Hub': 182, 'Agents': 153, 'Storage and cleanup': 130, 'Terminal': 70, 'General': 39, 'Notifications': 53, 'Files and Git': 40, 'Security and privacy': 59 }; // #10324: Network and Hub 171 to 182 (+11: Remote access and Manage other computers say their risk before the switch); Security and privacy 58 to 59 (+1: "Record what Coral types" for "Log terminal input"); Storage and cleanup 128 to 130 (+2: Shrink says what it shrinks, "Shrink saved diffs"); #9758: Storage and cleanup 105 to 128: the Board message search row (#9685), its label (3 words), its one-line hint (10), Learn more (2) and its status line (9) are 24 words, a feature's own row, not a paragraph that crept back; the rest of the group is as it was (103). // #7405: a row's hint is one short line (about ten words) under its label, and a longer one is behind its Learn more (UI/UX's rule: a tab about 120 words, Agents about 150; Network and Hub is its Hub status lines too, which are data); round 2: each Learn more-only row gets its one line (Agents +18, Storage +19 and +14 for the two limits' lines, Terminal +14); before #7405: Network and Hub 104, Agents 70, Storage and cleanup 65, Terminal 53, General 22, Notifications 7, Files and Git 16, Security and privacy 43 // (General: +7 on the assembled 168 for the auto-updater's setting row, #7360 on main: measured, the only group over) // Network and Hub 163 to 171: the Remote access hint (UI/UX, #7626) // Notifications 16 to 25: a full sentence for each hint and one for Desktop alerts (UI/UX, #7636) // #10068: Notifications 25 to 53: each switch says what it does, and the alert kinds (needs input, a finished reply) and the sound are switches of their own

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await client.Emulation.setFocusEmulationEnabled({ enabled: true });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(async () => { window.__coral.buildAllLazy(); const real = window.fetch; const json = b => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
            window.fetch = async (u, o = {}) => { const p = String(u); if (p.endsWith('/api/cloud/status')) return json({ configured: true, state: 'connected', hub_url: 'https://app.coralhub.dev', label: 'my-mac', server_id: 'srv_x', max_mode: 'launch', max_mode_saved: true, allow_hub_auto_accept: true, redact_tokens: true, hub_relaunch_updates: true, hub_cross_team_settings: true, allow_hub_auto_accept_changed: { by: 'hub', user: 'hub-user-3f2a', at: '2026-10-21T20:15:00Z' } }); if (/hub-operator/.test(p)) return json({ linked: true, disabled: false, recent_actions: [] }); if (p.split('?')[0].endsWith('/api/system/terminal-logs')) return json({ files: 0, bytes: 0, ended: { count: 0, bytes: 0 } }); if (p.split('?')[0].endsWith('/api/worktrees')) return json({ worktrees: [] }); return real(u, o); };
            const cc = await import((window.__coralStatic || '/static/') + 'cloud_connect.js'); cc.initCloudConnect(); await cc.loadCloudStatus(); return true; })()`);
        await ev(`window.showSettingsModal(); true`);
        await waitFor(`getComputedStyle(document.getElementById('settings-modal')).display !== 'none'`, 'the dialog open', 8000);
        await waitFor(`!!document.getElementById('settings-tab-network')`, 'the Settings dialog', 8000);
        await waitFor(`document.querySelectorAll('#settings-modal .settings-hint-line').length > 5`, 'the hint lines', 8000);
        // General opens on what people change first: Theme, then the default agent. The render engine is engine jargon (#6383 rank 12): it is behind a disclosure of its own.
        await ev(`document.getElementById('settings-tab-general').click(); true`);
        await waitFor(`!!document.querySelector('#settings-pane-general:not([hidden])')`, 'General open', 6000);
        const seen = id => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && e.checkVisibility({ checkVisibilityCSS: true }); })()`);
        assert.deepEqual(await ev(`[...document.querySelectorAll('#settings-pane-general select')].filter(e => e.checkVisibility({ checkVisibilityCSS: true })).slice(0, 2).map(e => e.id)`), ['settings-theme', 'settings-agent-type'], 'Theme, then Default agent type');
        // the render engine is a Terminal setting (#7040), behind a disclosure of its own
        await ev(`document.getElementById('settings-tab-terminal').click(); true`);
        await waitFor(`!!document.querySelector('#settings-pane-terminal:not([hidden])')`, 'Terminal open', 6000);
        assert.equal(await seen('settings-renderer-select'), false, 'the render engine is not shown until its disclosure opens');
        await ev(`document.querySelector('#settings-pane-terminal .settings-engine-more > summary').click(); true`);
        assert.equal(await seen('settings-renderer-select'), true, 'and is there when it does');
        await ev(`document.querySelector('#settings-pane-terminal .settings-engine-more').open = false; true`);
        await ev(`document.getElementById('settings-tab-general').click(); true`);
        await waitFor(`!!document.querySelector('#settings-pane-general:not([hidden])')`, 'General open again', 6000);
        const groups = await ev(`[...document.querySelectorAll('#settings-tabs [role=tab]')].map(b => ({ id: b.id, name: b.querySelector('.settings-tab-name').textContent.trim() }))`);
        for (const g of groups) {
            await ev(`document.getElementById(${JSON.stringify(g.id)}).click(); true`);
            await waitFor(`(() => { const p = document.querySelector('#settings-modal .settings-pane:not([hidden])'); return !!p && p.dataset.group === ${JSON.stringify(g.id.replace('settings-tab-', ''))}; })()`, `${g.name} shown`, 4000);
            await waitFor(`!/Loading…|Couldn't read/.test(document.querySelector('#settings-modal .settings-pane:not([hidden])').textContent)`, `${g.name} loaded`, 6000).catch(() => {}); // the count is of the settled pane (a pane that never settles is counted as it is)
            await ev(`(() => { const r = document.getElementById('settings-tools-folder-row'); if (r) r.hidden = true; return true; })()`); // the normal state has no warning row: a Windows runner shows it for real (its tools folder is a temp folder), and the 64-word state with it is checked on its own
            const words = await ev(`(() => { const pane = document.querySelector('#settings-modal .settings-pane:not([hidden])'); let n = 0;
                const shown = e => { for (let p = e; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || p.hidden) return false; const d = p.parentElement; if (d && d.tagName === 'DETAILS' && !d.open && p.tagName !== 'SUMMARY') return false; /* a closed disclosure hides what is in it */ } return true; };
                const w = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
                for (let t = w.nextNode(); t; t = w.nextNode()) { const e = t.parentElement; if (!e || e.closest('select, option, script, style, .material-icons') || !shown(e)) continue; n += t.nodeValue.trim().split(/\\s+/).filter(Boolean).length; }
                return n; })()`);
            (global.__tb = global.__tb || []).push(`${g.name}: ${words}`);
            const seenText = words > (BUDGET[g.name] ?? Infinity) ? await ev(`(() => { const pane = document.querySelector('#settings-modal .settings-pane:not([hidden])'); const out = []; const shown = e => { for (let p = e; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || p.hidden) return false; const d = p.parentElement; if (d && d.tagName === 'DETAILS' && !d.open && p.tagName !== 'SUMMARY') return false; } return true; }; const w = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) { const e = t.parentElement; if (!e || e.closest('select, option, script, style, .material-icons') || !shown(e)) continue; const v = t.nodeValue.trim(); if (v) out.push(v.slice(0, 80)); } return out; })()`) : null;
            if (!process.env.TB_DUMP && BUDGET[g.name] !== undefined) assert.ok(words <= BUDGET[g.name], `${g.name} shows ${words} words, budget ${BUDGET[g.name]}: ${JSON.stringify(seenText)}`);
        }

        if (process.env.TB_DUMP) assert.fail('TABLE ' + global.__tb.join(' | '));
        // every Hub row has its explanation as a visible hint line under its label (#7405: the (i) buttons are gone), the control still described by it; a long one shows a first line and a Learn more that opens the rest, by keyboard too
        await ev(`document.getElementById('settings-tab-network').click(); true`);
        const rows = await ev(`[...document.querySelectorAll('#settings-cloud .settings-cloud-switch-row:not([hidden]), #settings-cloud .settings-cloud-mode:not([hidden])')].map(r => { const h = r.matches('.settings-cloud-mode') ? r.querySelector('#settings-cloud-mode-levels') : r.querySelector('.settings-hint-line'); const input = r.querySelector('input[type=checkbox], select'); const d = ((input && input.getAttribute('aria-describedby')) || '').split(' '); return { id: r.id, hint: !!h, info: !!r.querySelector('.settings-info-btn'), words: h ? h.textContent.trim().split(/\\s+/).length : 0, describes: !!h && d.some(x => x && (h.id === x || !!h.querySelector('#' + CSS.escape(x)))) }; })`);
        assert.ok(rows.length >= 5, 'the Hub rows are shown: ' + JSON.stringify(rows.map(r => r.id)));
        for (const r of rows) {
            assert.equal(r.hint, true, `${r.id}: has its hint line`); assert.equal(r.info, false, `${r.id}: no (i)`); assert.ok(r.words > 3);
            assert.ok(r.describes, `${r.id}: the control is still described by the text`);
        }
        await ev(`document.querySelectorAll('#settings-cloud details.settings-cloud-more').forEach(d => { d.hidden = false; d.open = true; }); true`); // the permissions are behind the closed "More Coral Hub permissions" (#6579)
        const learn = `#settings-cloud-redact-row .settings-learn`;
        assert.equal(await ev(`!!document.querySelector('${learn}') && document.querySelector('${learn}').getAttribute('aria-expanded')`), 'false', 'a long hint is clamped to a line with a Learn more');
        await ev(`document.querySelector('${learn}').focus(); true`);
        await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await waitFor(`document.querySelector('${learn}').getAttribute('aria-expanded') === 'true' && !document.getElementById(document.querySelector('${learn}').getAttribute('aria-controls').split(' ')[0]).classList.contains('settings-hint-clamp')`, 'the redaction text open by keyboard', 3000);
        console.log('PASS Settings shows its hints, the long ones behind Learn more');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
