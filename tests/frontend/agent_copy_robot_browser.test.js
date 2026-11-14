// The robot "Copy for an agent" buttons (#15063, the Operator): a small icon button, named 'Copy for an agent', on a team's page (an item in its More menu since #15993, no robot beside its name), on each Team settings section, and beside the title and every
// section heading of a document in Docs; each copies the object's line and where in the agent docs to read ("Docs: coral-agent docs <topic>, section “<heading>”"), and says it was copied. The goal page's is in
// goal_copy_for_agent; the table behind them is checked against agent_docs/ in agent_doc_map.test.mjs. Real board on the isolated dev server (removed again); the clipboard is a stand-in. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ar-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const clip = () => ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true`);
    const robotInfo = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), title: b.title, icon: b.querySelector('.material-icons')?.textContent, text: b.textContent.replace(/smart_toy/, '').trim(), w: Math.round(r.width), h: Math.round(r.height), within: r.right <= innerWidth + 1 && r.width > 0 }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        const sub = await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + ${JSON.stringify(B)} }) }).then(r => r.status)`);
        assert.ok(sub < 300);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });

            console.log(`${at}1. The team page has no robot beside its name: Copy for an agent is in More (#15993)`);
            await load(`/team/${B}`);
            await waitFor(`document.getElementById('team-page-title') && document.getElementById('team-page-title').textContent.length > 0 && !!document.getElementById('team-page-more')`, `${at}the team page header`, 15000);
            await clip();
            assert.equal(await ev(`!!document.getElementById('team-page-agent-copy') || !!document.querySelector('#team-page-head .agent-copy')`), false, at + 'no robot beside the name');
            await ev(`document.getElementById('team-page-more').click(); true`);
            await waitFor(`!!document.getElementById('team-page-more-copy') && document.getElementById('team-page-more-copy').getClientRects().length > 0`, at + 'Copy for an agent in More', 8000);
            const item = await ev(`(() => { const m = document.getElementById('team-page-more-copy'); const items = [...document.querySelectorAll('#team-page-more-menu .menu-item')].filter(x => x.getClientRects().length); return { text: m.textContent.trim(), last: items[items.length - 1] === m }; })()`);
            assert.equal(item.text, 'Copy for an agent', at + 'worded Copy for an agent');
            await ev(`document.getElementById('team-page-more-copy').click(); true`);
            await waitFor(`window.__copied.length === 1`, `${at}the text copied`, 8000);
            const copied = (await ev(`window.__copied[0]`));
            assert.ok(copied.includes(B) && /coral-board read/.test(copied) && /\nDocs: coral-agent docs board, section “Messages”$/.test(copied), at + 'the team, its command, then the docs: ' + JSON.stringify(copied));
            await waitFor(`/Copied/.test(document.body.innerText)`, `${at}the toast says so`, 8000);

            console.log(`${at}2. Each Team settings section has one, naming the team and the section`);
            await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(B)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })); true`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, `${at}the Team settings`, 15000);
            const secs = await ev(`[...document.querySelectorAll('#team-settings-workspace .settings-pane[data-section]')].filter(p => p.querySelector(':scope > .agent-copy-hrow > .agent-copy')).map(p => p.dataset.section)`);
            assert.ok(secs.includes('workflow') && secs.includes('health'), at + 'the sections have the robot: ' + secs);
            await ev(`document.querySelector('#team-settings-workspace .settings-tab[data-section=health]').click(); true`);
            await clip(); await ev(`document.querySelector('#team-settings-workspace .settings-pane[data-section=health] > .agent-copy-hrow > .agent-copy').click(); true`);
            await waitFor(`window.__copied.length === 1`, `${at}the section's line copied`, 8000);
            const sc = await ev(`window.__copied[0]`);
            assert.ok(sc.includes(B) && /Health check/.test(sc) && /\nDocs: coral-agent docs using-the-dashboard, section “Turn on the team health monitor”$/.test(sc), at + 'the team, the section, then the docs: ' + JSON.stringify(sc));

            console.log(`${at}3. A document in Docs has one beside its sections, copying the exact place`);
            await load('/docs/board');
            await waitFor(`document.querySelectorAll('#docs-content .docs-hrow > .agent-copy').length > 3`, `${at}the robots in the document`, 15000);
            const heads = await ev(`(() => { const row = [...document.querySelectorAll('#docs-content .docs-hrow')].find(r => r.querySelector(':scope > h2')); return { section: row.querySelector('h2').textContent.trim(), label: row.querySelector('.agent-copy').getAttribute('aria-label'), tag: row.querySelector('h2').tagName }; })()`);
            assert.ok(/^Copy for an agent: /.test(heads.label) && heads.label.endsWith(heads.section), at + 'named for its section: ' + JSON.stringify(heads));
            await clip(); await ev(`[...document.querySelectorAll('#docs-content .docs-hrow')].find(r => r.querySelector(':scope > h2')).querySelector('.agent-copy').click(); true`);
            await waitFor(`window.__copied.length === 1`, `${at}the place copied`, 8000);
            const dc = await ev(`window.__copied[0]`);
            assert.equal(dc, `Docs: coral-agent docs board, section “${heads.section.replace(/\s*\(#\d+\)\s*$/, '')}”`, at + 'just the exact place');

            console.log(`${at}4. Settings > General has no robot: a labelled Quiet button on the section's last row (#15993)`);
            await load('/');
            await ev(`window.showSettingsModal(); true`);
            await waitFor(`!!document.querySelector('#settings-pane-general .settings-copy-last button')`, `${at}the General section's button`, 15000);
            const gen = await ev(`(() => { const p = document.getElementById('settings-pane-general'), b = p.querySelector('.settings-copy-last button'); return { text: b.textContent.trim(), quiet: b.classList.contains('btn-quiet'), robot: !!p.querySelector('.agent-copy'), last: p.lastElementChild === b.parentElement, icon: !!b.querySelector('.material-icons') }; })()`);
            assert.ok(gen.text === 'Copy for an agent' && gen.quiet && !gen.robot && gen.last && !gen.icon, at + 'words, Quiet, last, no robot: ' + JSON.stringify(gen));
            assert.ok(await ev(`!!document.querySelector('#settings-pane-updates .agent-copy, #settings-pane-agents .agent-copy')`), at + 'the other sections keep their robot');
            await clip(); await ev(`document.querySelector('#settings-pane-general .settings-copy-last button').click(); true`);
            await waitFor(`window.__copied.length === 1`, `${at}General's line copied`, 8000);
            const genTitle = await ev(`document.getElementById('settings-pane-general').dataset.title`);
            assert.ok(genTitle, at + 'the section has a title');
            assert.ok((await ev(`window.__copied[0]`)).includes(`\u201c${genTitle}\u201d section`), at + 'names the section by its own title: ' + genTitle);
        }
        console.log('PASS agent copy robot');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
