// The Team settings dialog's tabs by keyboard (#4026 follow-up), against stubbed APIs (the leave-with-unsaved-changes question and the Team Artifacts tab's keys went with the right dock, #7457: the team page has its own suites):
//   Team settings: a real tablist (three tabs, roving tabindex, aria-controls, each panel labelled by its tab); Left, Right, Home and End move
//   and select; Tab goes from the selected tab into its panel; every field has a name; Enter in the preset name box does not save the whole
//   form.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');

const HEX = n => String(n).repeat(64).slice(0, 64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw and a layout settle over frames; there is no completion event
    const press = async (k, code, vk, modifiers = 0) => { const b = { key: k, code, windowsVirtualKeyCode: vk, modifiers }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { cls: String(a.className), id: a.id, label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30), tag: a.tagName.toLowerCase(), tab: a.dataset ? a.dataset.settingsTab || null : null, inside: a.closest ? !!a.closest('#team-working-mode-dialog') : false } : null; })()`);
    const ART = i => ({ name: `plan-${i}.md`, uri: `coral://artifacts/${HEX(i)}`, media_type: 'text/markdown', size: 1024 * i, created_at: '2026-10-16T10:00:00Z', task_id: i, task_title: `Task ${i}`, produced_by: 'PM' });
    const team = 'kb-team-' + Date.now();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.then(() => true)`);
        await ev(`(() => { const R = window.fetch; window.__calls = []; window.__pages = 0; window.__kept = new Set();
            const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }));
            window.fetch = (u, o = {}) => { const url = new URL(String(u), location.origin); const m = (o.method || 'GET').toUpperCase(); const p = url.pathname; const board = p.startsWith('/api/board/');
                if (board && p.endsWith('/working-mode') ) { window.__calls.push(m + ' working-mode'); return json({ mode: 'none', dependency_guidance: false, custom_instructions: '' }); }
                if (board && p.endsWith('/working-mode/presets')) return json({ presets: [{ id: 'shared_checkout', name: 'Shared checkout', builtin: true, instructions: 'Share one checkout.' }] });
                if (board && p.endsWith('/settings')) return json({ cross_team_messaging: false });
                if (p === '/api/settings/prompt-inspection') return json({ orchestrator: { scope: 'global', applies: 'x', default: 'd', effective: 'e' }, worker: {}, task: {} });
                if (p === '/api/settings' && m === 'GET') return json({ settings: { board_health_monitor: 'true' } });
                if (board && p.endsWith('/artifacts')) { const off = Number(url.searchParams.get('offset') || 0); window.__calls.push('GET artifacts ' + off);
                    const items = off === 0 ? [${[1, 2, 3].map(i => JSON.stringify(ART(i))).join(',')}] : [${JSON.stringify(ART(4))}];
                    return json({ project: decodeURIComponent(p.split('/')[3]), artifacts: items, has_more: off === 0, truncated: false }); }
                if (p === '/api/system/artifact-store/kept') return json({ kept: [...window.__kept] });
                { const k = /^\\/api\\/artifacts\\/([a-f0-9]{64})\\/keep$/.exec(p); if (k) { window.__calls.push(m + ' keep'); if (m === 'PUT') window.__kept.add(k[1]); else window.__kept.delete(k[1]); return json({ ok: true }); } }
                return R(u, o); };
            return true; })()`);
        await ev(`window.__m.add('kb-bot', 'A', 4, { sleeping: false, board_project: ${JSON.stringify(team)} }); true`); await sleep(800); // sleep-ok: a redraw and a layout settle over frames; no completion event
        await ev(`window.selectLiveSession('kb-bot', 'claude', 'kb-bot-id', 'local'); true`); await sleep(1200); // sleep-ok: a redraw and a layout settle over frames; no completion event

        console.log('1. Team settings: the tablist');
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_working_mode.js'); await m.showTeamWorkingMode(${JSON.stringify(team)}); return true; })()`);
        await waitFor(`!!document.querySelector('#team-working-mode-dialog .team-settings-tabs [role=tab]') && document.querySelector('#team-working-mode-dialog .working-mode-form').dataset.initialState !== undefined`, 'the loaded settings', 8000);
        const tl = await ev(`(() => { const d = document.getElementById('team-working-mode-dialog'); const tabs = [...d.querySelectorAll('[role=tab]')]; return { n: tabs.length, sel: tabs.map(t => t.getAttribute('aria-selected')), tab: tabs.map(t => t.tabIndex), controls: tabs.map(t => !!document.getElementById(t.getAttribute('aria-controls'))),
            labelled: [...d.querySelectorAll('[role=tabpanel]')].map(p => { const by = p.getAttribute('aria-labelledby'); return !!by && !!document.getElementById(by) && document.getElementById(by).getAttribute('aria-controls') === p.id; }), hidden: [...d.querySelectorAll('[role=tabpanel]')].map(p => p.hidden) }; })()`);
        assert.equal(tl.n, 3, 'Workflow, Prompt inspection and Messaging (#5516: the list can be prepared before it is enforced)'); assert.deepEqual(tl.sel, ['true', 'false', 'false']); assert.deepEqual(tl.tab, [0, -1, -1], 'roving tabindex: only the selected tab is a Tab stop');
        assert.deepEqual(tl.controls, [true, true, true], 'aria-controls names a real panel'); assert.deepEqual(tl.hidden, [false, true, true]);
        assert.deepEqual(tl.labelled, [true, true, true], 'each panel is labelled by its tab');

        console.log('2. Team settings: arrow keys');
        await ev(`document.querySelector('#team-working-mode-dialog [data-settings-tab=workflow]').focus(); true`);
        for (const [k, code, vk, want] of [['ArrowRight', 'ArrowRight', 39, 'prompts'], ['End', 'End', 35, 'messaging'], ['ArrowRight', 'ArrowRight', 39, 'workflow'], ['ArrowLeft', 'ArrowLeft', 37, 'messaging'], ['Home', 'Home', 36, 'workflow']]) {
            await press(k, code, vk);
            const a = await active();
            assert.equal(a.tab, want, `${k} moves the focus to ${want}`);
            assert.equal(await ev(`document.querySelector('#team-working-mode-dialog [data-settings-tab=${want}]').getAttribute('aria-selected')`), 'true', `${k} selects ${want}`);
            assert.equal(await ev(`document.querySelector('#team-working-mode-dialog [data-settings-panel=${want}]').hidden`), false, `${want}'s panel is shown`);
        }
        await press('Tab', 'Tab', 9);
        const into = await ev(`(() => { const a = document.activeElement; return { panel: a.dataset && a.dataset.settingsPanel, inPanel: !!a.closest('[data-settings-panel=workflow]') }; })()`);
        assert.equal(into.inPanel, true, 'Tab from the selected tab goes into its panel');

        console.log('3. Team settings: fields and Enter');
        const unnamed = await ev(`[...document.querySelectorAll('#team-working-mode-dialog input, #team-working-mode-dialog select, #team-working-mode-dialog textarea')].filter(e => !e.closest('[hidden]') && !(e.labels && e.labels.length) && !e.getAttribute('aria-label')).map(e => e.name || e.className)`);
        assert.deepEqual(unnamed, [], 'every field has a label: ' + unnamed.join(', '));
        await ev(`window.__calls.length = 0; const n = document.querySelector('#team-working-mode-dialog [name=preset_name]'); n.removeAttribute('readonly'); n.readOnly = false; n.focus(); true`);
        await press('Enter', 'Enter', 13); await sleep(500); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.ok(!(await ev(`window.__calls.includes('PUT working-mode')`)), 'Enter in the preset name box does not save the whole team settings form');

        console.log('\nPASS team settings tabs by keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
