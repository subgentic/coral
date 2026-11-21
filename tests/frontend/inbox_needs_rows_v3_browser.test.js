// Needs you rows, guidelines v3 section 4.14 (#17451): one row anatomy, tick box, icon and name at the same x on every row (N3); an agent's prompt has a tick box and its Dismiss in the kebab (N5); the wait is grey and short, the amber triangle only past a day (N7). 1440, 1280, 390.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle, coralReady } = require('./helpers/wait').bind(ev);
    const S = `(window.__coralStatic || '/static/')`;
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [1280, 800, false], [390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady();
            await ev(`try { localStorage.removeItem('coral-inbox-needs-filters'); } catch {} true`);
            await ev(`(() => { for (let i = 0; i < 5; i++) window.__m.add('Agent ' + i, String.fromCharCode(65 + i), 4, { sleeping: false, board_project: 'team-' + (i % 2), session_id: 'sid-' + i }); return true; })()`);
            await waitFor(`(window.__qaState && window.__qaState.liveSessions || []).length === 5`, 'five agents', 8000);
            await ev(`(async () => { const ago = m => new Date(Date.now() - m * 60000).toISOString(); const K = ['permission', 'question', 'plan', 'permission', 'question'];
                window.__qaState.liveSessions = window.__qaState.liveSessions.map((s, i) => ({ ...s, waiting_for_input: true, waiting_kind: K[i], waiting_since: ago(i === 4 ? 2 * 24 * 60 : 3 + i * 40) }));
                (await import(${S} + 'inbox_tab.js')).updateInboxTab(); return true; })()`);
            await ev(`window.switchNavTab('hub-inbox'); true`);
            await waitFor(`document.querySelectorAll('.view-list-item').length > 3`, 'the folders', 10000);
            if (mobile) await ev(`document.querySelector('#group-table-view .view-list-item[data-key="needs"]')?.click(); true`); else await ev(`document.querySelector('.view-list-item[data-key="needs"]').click(); true`);
            await waitFor(`document.querySelectorAll('#group-table-view button.dt-primary, #group-table-view button.dt-person').length >= 5`, 'the five rows', 8000); await settle(400);
            await shot(`needs-${w}`);
            const g = await ev(`(() => { const rows = [...document.querySelectorAll('#group-table-view tbody tr:not(.dt-group)')].filter(r => r.querySelector('.inbox-kind-icon')), x = (r, sel) => { const e = r.querySelector(sel); return e && e.getClientRects().length ? Math.round(e.getBoundingClientRect().left) : null; };
                return { n: rows.length, icon: rows.map(r => x(r, '.inbox-kind-icon')), name: rows.map(r => x(r, '.inbox-review-name, .inbox-agent-first .inbox-review-from, .dt-person')), check: rows.map(r => x(r, '.dt-check input')),
                    ages: rows.map(r => { const a = r.querySelector('.inbox-age .inbox-age-t, .inbox-review-elapsed'); return a ? (a.textContent || a.dataset.elapsed || '') : ''; }), flags: rows.map(r => !!r.querySelector('.inbox-age-flag')), ageWords: rows.map(r => { const a = r.querySelector('.inbox-age'); return a ? [...a.children].filter(n => n.classList.contains('inbox-age-t')).map(n => n.textContent).join('') : ''; }),
                    dismissBtn: rows.map(r => !!r.querySelector('button.inbox-dismiss')), kebab: rows.map(r => !!r.querySelector('.inbox-row-more-toggle')) }; })()`);
            assert.equal(g.n, 5, `${w}: five rows`);
            assert.equal(new Set(g.icon.filter(v => v !== null)).size, 1, `${w}: the icon starts at the same x on every row: ${JSON.stringify(g.icon)}`);
            if (w >= 1000) assert.equal(new Set(g.name.filter(v => v !== null)).size, 1, `${w}: the name starts at the same x on every row: ${JSON.stringify(g.name)}`);
            if (w >= 1000) {
                assert.ok(g.check.every(v => v !== null) && new Set(g.check).size === 1, `${w}: every row, an agent's prompt too, has a tick box at the same x: ${JSON.stringify(g.check)}`);
                assert.deepEqual(g.dismissBtn, [true, true, true, true, true], `${w}: Dismiss is direct at rest (#20203)`);
                assert.ok(g.kebab.every(v=>!v), `${w}: no single-item kebab remains: ${JSON.stringify(g.kebab)}`);
                assert.ok(g.ageWords.every(t => /^(<1 min|\d+ min|\d+ h|\d+ d)$/.test(t)), `${w}: the wait is short and has no word "waiting": ${JSON.stringify(g.ageWords)}`);
                assert.deepEqual(g.flags, [false, false, false, false, true], `${w}: the amber triangle only on the wait past the limit: ${JSON.stringify(g.flags)}`);
            }
            await shot(`rows-${w}`);
        }
        await client.close(); process.exit(0);
    } catch (e) { console.error('FAIL', e && e.stack || e); await client.close().catch(() => {}); process.exit(1); }
})();
