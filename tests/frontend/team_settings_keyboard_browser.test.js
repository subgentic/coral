// The Team settings dialog's tabs by keyboard (#4026 follow-up), against stubbed APIs (the leave-with-unsaved-changes question and the Team Artifacts tab's keys went with the right dock, #7457: the team page has its own suites):
//   Team settings: a real tablist (three tabs, roving tabindex, aria-controls, each panel labelled by its tab); Left, Right, Home and End move
//   and select; Tab goes from the selected tab into its panel; every field has a name; Enter in the preset name box does not save the whole
//   form.
// Run against an isolated dev server.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');

const HEX = n => String(n).repeat(64).slice(0, 64);

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const sleep = ms => new Promise(r => setTimeout(r, ms)); // sleep-ok: a redraw and a layout settle over frames; there is no completion event
    const press = async (k, code, vk, modifiers = 0) => { const b = { key: k, code, windowsVirtualKeyCode: vk, modifiers }; await Input.dispatchKeyEvent({ type: 'keyDown', ...b, ...(k === 'Enter' ? { text: '\r' } : k === ' ' ? { text: ' ' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', ...b }); };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? { cls: String(a.className), id: a.id, label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30), tag: a.tagName.toLowerCase(), tab: a.dataset ? a.dataset.section || null : null, inside: a.closest ? !!a.closest('#team-settings-workspace') : false } : null; })()`);
    const ART = i => ({ name: `plan-${i}.md`, uri: `coral://artifacts/${HEX(i)}`, media_type: 'text/markdown', size: 1024 * i, created_at: '2026-10-16T10:00:00Z', task_id: i, task_title: `Task ${i}`, produced_by: 'PM' });
    const team = 'kb-team-' + Date.now();
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        await coralReady(ev);
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
        await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_working_mode.js'); await m.showTeamWorkingMode(${JSON.stringify(team)}, { page: document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' })) }); return true; })()`);
        await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, 'the loaded settings', 8000);
        const tl = await ev(`(() => { const d = document.getElementById('team-settings-workspace'); const tabs = [...d.querySelectorAll('.settings-tab')]; return { names: tabs.map(t => t.dataset.section), sel: tabs.map(t => t.getAttribute('aria-selected')), tab: tabs.map(t => t.tabIndex), controls: tabs.map(t => !!document.getElementById(t.getAttribute('aria-controls'))),
            labelled: [...d.querySelectorAll('[role=tabpanel]')].map(p => { const by = p.getAttribute('aria-labelledby'); return !!by && !!document.getElementById(by) && document.getElementById(by).getAttribute('aria-controls') === p.id; }), hidden: [...d.querySelectorAll('[role=tabpanel]')].map(p => p.hidden) }; })()`);
        const names = tl.names, n = names.length;
        assert.deepEqual(names.filter(x => x !== 'health'), ['workflow', 'messaging', 'prompts'], 'Workflow, Messaging and Prompts (Health check when the board serves it)');
        assert.deepEqual(tl.sel, names.map((x, i) => String(i === 0)));
        assert.deepEqual(tl.tab, names.map((x, i) => (i === 0 ? 0 : -1)), 'roving tabindex: only the selected tab is a Tab stop');
        assert.deepEqual(tl.controls, names.map(() => true), 'aria-controls names a real panel'); assert.deepEqual(tl.hidden, names.map((x, i) => i !== 0));
        assert.deepEqual(tl.labelled, names.map(() => true), 'each panel is labelled by its tab');

        console.log('2. Team settings: arrow keys (the list is vertical: Up and Down)');
        await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=workflow]').focus(); true`);
        for (const [k, code, vk, want] of [['ArrowDown', 'ArrowDown', 40, names[1]], ['End', 'End', 35, names[n - 1]], ['ArrowDown', 'ArrowDown', 40, names[0]], ['ArrowUp', 'ArrowUp', 38, names[n - 1]], ['Home', 'Home', 36, names[0]]]) {
            await press(k, code, vk);
            const a = await active();
            assert.equal(a.tab, want, `${k} moves the focus to ${want}`);
            assert.equal(await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=${want}]').getAttribute('aria-selected')`), 'true', `${k} selects ${want}`);
            assert.equal(await ev(`document.querySelector('#team-settings-workspace .settings-pane[data-section=${want}]').hidden`), false, `${want}'s panel is shown`);
        }
        await press('Tab', 'Tab', 9);
        const into = await ev(`(() => { const a = document.activeElement; return { inPanel: !!a.closest('.settings-pane[data-section=workflow]') }; })()`);
        assert.equal(into.inPanel, true, 'Tab from the selected tab goes into its panel');

        console.log('3. Team settings: fields and Enter');
        const unnamed = await ev(`[...document.querySelectorAll('#team-settings-workspace input, #team-settings-workspace select, #team-settings-workspace textarea')].filter(e => !e.closest('[hidden]') && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map(e => e.name || e.className)`);
        assert.deepEqual(unnamed, [], 'every field has a label: ' + unnamed.join(', '));
        await ev(`window.__calls.length = 0; const n = document.querySelector('#team-settings-workspace [name=preset_name]'); n.removeAttribute('readonly'); n.readOnly = false; n.focus(); true`);
        await press('Enter', 'Enter', 13); await sleep(500); // sleep-ok: a redraw and a layout settle over frames; no completion event
        assert.ok(!(await ev(`window.__calls.includes('PUT working-mode')`)), 'Enter in the preset name box does not save the page');

        console.log('\nPASS team settings tabs by keyboard');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
