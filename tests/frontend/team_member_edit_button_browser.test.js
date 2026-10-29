// A team member's row has one button, Edit <name>, at its end (#10836, the operator): no chevron and no "..." menu, Edit and the row open the Edit member dialog, Remove from team is in that dialog (Undo as before),
// Move up and Move down are gone and Alt+ArrowUp / Alt+ArrowDown on the focused row reorder it, said politely. 1280 and 390 px; the Orchestrator keeps its rules (not removed, not moved up). Isolated dev server over CDP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const guard = await require('./helpers/settings_guard').guardSettings();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await Page.navigate({ url: BASE }); await Page.loadEventFired(); await install();
        await ev(`window.__coralReady.startup('liveList', 'settings')`);
        await ev(`(async () => { await window.showLaunchModal(); window.hideLaunchModal(); return true; })()`);
        const roles = () => ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row .team-agent-role-name')].map(e => e.textContent)`);
        const key = async (key, mods = 1) => { // Alt (modifiers 1)
            await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 40, modifiers: mods });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowUp' ? 38 : 40, modifiers: mods });
        };
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile, maxTouchPoints: 5 });
            await ev(`(async () => { await window.showLaunchModal(); window._selectLaunchType('team'); return true; })()`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && document.querySelectorAll('#team-agents-list .team-agent-row').length >= 3`, `${w}: the default team`, 8000);
            await ev(`(async () => { const m = await import((window.__coralStatic || '/static/') + 'team_steps.js'); m.showTeamStep('members'); return true; })()`);
            const start = await roles();
            assert.deepEqual(start.slice(0, 3), ['Orchestrator', 'Lead Developer', 'QA Engineer'], `${w}: the default team`);
            // one button per row, named Edit <name>, no chevron, no menu, 44 px
            const rows = await ev(`[...document.querySelectorAll('#team-agents-list .team-agent-row')].map(r => { const bs = [...r.querySelectorAll('button')].filter(b => b.getClientRects().length); const role = r.querySelector('.team-agent-role-name').textContent; const rb = bs[0] && bs[0].getBoundingClientRect(), rr = r.getBoundingClientRect(); return { role, n: bs.length, name: bs[0] && (bs[0].getAttribute('aria-label') || bs[0].textContent), text: bs[0] && bs[0].textContent.trim(), h: rb && Math.round(rb.height), w: rb && Math.round(rb.width), atEnd: rb && rr.right - rb.right < 24, chev: !!r.querySelector('.team-agent-chev'), menu: !!r.querySelector('.team-agent-menu-btn, [role=menu], [data-dir]') }; })`);
            for (const r of rows) {
                assert.equal(r.n, 1, `${w}: ${r.role} has exactly one button`);
                assert.equal(r.name, `Edit ${r.role}`, `${w}: its name`);
                assert.equal(r.text, 'Edit', `${w}: it says Edit`);
                assert.ok(!r.chev && !r.menu, `${w}: ${r.role} has no chevron and no menu`);
                assert.ok(r.atEnd, `${w}: ${r.role}: Edit is at the row's end`);
                if (mobile) assert.ok(r.h >= 44 && r.w >= 44, `${w}: Edit is 44 px: ${r.w}x${r.h}`);
            }
            // Alt+ArrowDown moves the focused row down and says so; Alt+ArrowUp moves it back; the order is the form's (the list)
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[1].querySelector('button').focus(); true`);
            await key('ArrowDown');
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-role-name')[2].textContent === 'Lead Developer'`, `${w}: Alt+Down moved it`, 3000);
            assert.match(await ev(`document.getElementById('team-agents-live').textContent`), /^Moved Lead Developer to 3 of \d+$/, `${w}: said politely`);
            assert.equal(await ev(`document.activeElement.getAttribute('aria-label')`), 'Edit Lead Developer', `${w}: the focus stays on the moved row's button`);
            await key('ArrowUp');
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-role-name')[1].textContent === 'Lead Developer'`, `${w}: Alt+Up moved it back`, 3000);
            // the Orchestrator does not move up
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[0].querySelector('button').focus(); true`);
            await key('ArrowUp');
            assert.equal((await roles())[0], 'Orchestrator', `${w}: the first row stays first`);
            // Move up / Move down in Edit member (#10868): a single-pointer way to reorder, for touch; the dialog stays open, it is said politely, the order is the form's
            const tap = async sel => { const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`); if (mobile) { await client.Input.dispatchTouchEvent({ type: 'touchStart', touchPoints: [{ x: r[0], y: r[1] }] }); await client.Input.dispatchTouchEvent({ type: 'touchEnd', touchPoints: [] }); } else await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`); };
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[1].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-move-down').getClientRects().length > 0`, `${w}: Edit member has Move down`, 5000);
            const mv = await ev(`['up', 'down'].map(d => { const b = document.getElementById('launch-agent-move-' + d), r = b.getBoundingClientRect(); return { text: b.textContent.trim(), disabled: b.disabled, shown: b.getClientRects().length > 0, h: Math.round(r.height), w: Math.round(r.width) }; })`);
            assert.deepEqual(mv.map(m => [m.text, m.disabled, m.shown]), [['Move up', false, true], ['Move down', false, true]], `${w}: Move up and Move down are in Edit member`);
            if (mobile) assert.ok(mv.every(m => m.h >= 44), `${w}: 44 px: ${JSON.stringify(mv)}`);
            if (process.env.CORAL_SCREENSHOT_DIR) { fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true }); fs.writeFileSync(`${process.env.CORAL_SCREENSHOT_DIR}/edit-member-${w}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); }
            const over = await ev(`(() => { const a = document.querySelector('#launch-step-agent .modal-actions'); return a.scrollWidth > a.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth; })()`);
            assert.equal(over, false, `${w}: Edit member's buttons fit without sideways scroll`);
            await tap('#launch-agent-move-down');
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-role-name')[2].textContent === 'Lead Developer'`, `${w}: Move down moved the member`, 3000);
            assert.match(await ev(`document.getElementById('launch-stage-live').textContent`), /^Moved Lead Developer to 3 of \d+$/, `${w}: said politely`);
            assert.equal(await ev(`document.getElementById('launch-agent-title-text').textContent`), 'Edit member', `${w}: the dialog stays open`);
            await tap('#launch-agent-move-up');
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-role-name')[1].textContent === 'Lead Developer'`, `${w}: Move up moved it back`, 3000);
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, `${w}: closed`, 5000);
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[0].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-move-down').getClientRects().length > 0`, `${w}: Edit member of the Orchestrator`, 5000);
            assert.deepEqual(await ev(`['up', 'down'].map(d => document.getElementById('launch-agent-move-' + d).disabled)`), [true, false], `${w}: the Orchestrator does not move up, as before`);
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, `${w}: closed again`, 5000);
            // Edit and the row open the dialog; Remove from team is in it
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[2].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-save').getClientRects().length > 0`, `${w}: Edit opens Edit member`, 5000);
            assert.equal(await ev(`document.getElementById('launch-agent-remove').getClientRects().length > 0`), true, `${w}: Remove from team is in the dialog`);
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await waitFor(`getComputedStyle(document.getElementById('launch-step-team')).display !== 'none' && !document.getElementById('launch-modal').hasAttribute('data-member')`, `${w}: back on the team form`, 5000);
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[0].querySelector('.team-agent-open').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member'`, `${w}: the row opens it too`, 5000);
            assert.equal(await ev(`document.getElementById('launch-agent-remove').getClientRects().length`), 0, `${w}: the Orchestrator is not removed`);
            await ev(`document.getElementById('launch-agent-cancel').click(); true`);
            await waitFor(`!document.getElementById('launch-modal').hasAttribute('data-member')`, `${w}: closed`, 5000);
            await ev(`document.querySelectorAll('#team-agents-list .team-agent-row')[2].querySelector('button').click(); true`);
            await waitFor(`document.getElementById('launch-agent-title-text').textContent === 'Edit member' && document.getElementById('launch-agent-remove').getClientRects().length > 0`, `${w}: Edit member again`, 5000);
            const before = (await roles()).length;
            await ev(`document.getElementById('launch-agent-remove').click(); true`);
            await waitFor(`document.querySelectorAll('#team-agents-list .team-agent-row').length === ${before - 1}`, `${w}: Remove from team removed the member`, 5000);
            assert.ok(!(await roles()).includes('QA Engineer'), `${w}: the QA Engineer is gone`);
            assert.match(await ev(`document.getElementById('team-undo').textContent`), /Removed QA Engineer\. Undo/, `${w}: Undo is offered as before`);
            await ev(`document.querySelector('#team-undo [data-on-click="team-agent-undo"]').click(); true`);
            assert.equal((await roles()).length, before, `${w}: Undo brings it back`);
            await ev(`window.hideLaunchModal(); true`);
        }
        console.log('PASS team member rows: one Edit button, Remove in the dialog, Alt+Arrow reorders');
    } finally { try { await guard.restore(); } catch (e) {} try { await client.close(); } catch (e) {} }
})().catch(e => { console.error(e); process.exit(1); });
