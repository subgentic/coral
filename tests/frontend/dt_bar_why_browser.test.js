// An action the selection bar has switched off says why (#15015, UI Accessibility): the button's title and one line on the bar, so a keyboard, a screen reader and a touch screen all get the reason ('Dismiss is off: a proposal is approved or
// rejected, not dismissed.'); with a selection that is fine the action is on and the line is gone. A real data table with one action; 1280 and 390 px.
'use strict';
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [], check = (ok, msg) => { if (!ok) problems.push(msg); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1280, 800, false], [390, 844, true]]) {
            const at = `${w} px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'settings');
            await ev(`(async () => { const DT = await import((window.__coralStatic || '/static/') + 'data_table.js'); document.getElementById('qa-host')?.remove(); const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-host', style: 'position:fixed;inset:60px 0 0 0;z-index:90;background:var(--bg-primary);overflow:auto' }));
                const rows = [{ id: 1, name: 'plain file', proposal: false }, { id: 2, name: 'a proposal', proposal: true }];
                const cols = [{ key: 'name', label: 'Name', primary: true, width: 'grow', line: 1, field: 'name', cell: r => DT.primaryButton(r.name, 'Open ' + r.name) }];
                const t = DT.dataTable({ label: 'WhyFixture', columns: cols, rows, rowKey: r => 'r' + r.id, open: () => {}, rowName: r => r.name, state: DT.tableState(),
                    selectable: { contextKey: 'why', iconBar: false, clearLabel: 'Done', actions: [{ label: 'Dismiss', disabled: rs => rs.some(r => r.proposal), why: rs => rs.some(r => r.proposal) ? 'a proposal is approved or rejected, not dismissed.' : '', run: () => {} }], onChange: () => {} } });
                host.append(t.bar, t.selectButton, t.el); return true; })()`);
            await waitFor(`document.querySelectorAll('#qa-host tbody .dt-check input').length === 2`, `${at}two rows with checkboxes`, 8000);
            const pick = n => ev(`document.querySelectorAll('#qa-host tbody .dt-check input')[${n}].click(); true`);
            await pick(0);
            await waitFor(`!!document.querySelector('#qa-host .dt-bar') && /1 selected/.test(document.querySelector('#qa-host .dt-bar').textContent)`, `${at}1 selected`, 6000);
            const ok = await ev(`(() => { const b = [...document.querySelectorAll('#qa-host .dt-bar button')].find(x => x.textContent.trim() === 'Dismiss'); return { on: !!b && !b.disabled, why: !!document.querySelector('#qa-host .dt-bar-why') }; })()`);
            check(ok.on && !ok.why, `${at}a plain file: Dismiss is on and there is no reason line: ${JSON.stringify(ok)}`);
            await pick(1);
            await waitFor(`/2 selected/.test(document.querySelector('#qa-host .dt-bar')?.textContent || '')`, `${at}2 selected`, 6000);
            const off = await ev(`(() => { const b = [...document.querySelectorAll('#qa-host .dt-bar button')].find(x => x.textContent.trim() === 'Dismiss'); const w = document.querySelector('#qa-host .dt-bar-why'); return { off: !!b && b.disabled, title: b ? b.title : '', line: w ? w.textContent : '', role: w ? w.getAttribute('role') : '' }; })()`);
            check(off.off && /Dismiss is off: a proposal is approved or rejected, not dismissed\./.test(off.title) && /Dismiss is off: a proposal/.test(off.line) && off.role === 'status', `${at}with a proposal selected Dismiss is off and says why (title and a status line): ${JSON.stringify(off)}`);
        }
    } finally { await client.close(); }
    if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('dt_bar_why_browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
