// The robot "Copy for an agent" on the screens #15063 left (#15152): the agent page, the Needs you list, Saved, the Merge queue working mode, and each section of the main Settings (Notifications and
// Network and Hub point at their own docs topic). Each is a 'Copy for an agent' icon that copies the screen's line and where in the agent docs to read. The Hub's Computers page has the same
// robot (cloud_server_view.js); it needs a Hub session, so it is pinned by agent_doc_map.test.mjs (the topic) and not driven here. Real board on the isolated dev server (removed again); the clipboard is a stand-in. 1280 and 390 px.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const B = 'ap-' + Date.now().toString(36);
    const S = `(window.__coralStatic || '/static/')`;
    const load = async url => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); };
    const clip = () => ev(`window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true }); true`);
    const info = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); const c = getComputedStyle(b); return { label: b.getAttribute('aria-label'), icon: b.querySelector('.material-icons')?.textContent, shown: r.width > 0 && c.display !== 'none' && c.visibility !== 'hidden', inView: r.left >= 0 && r.right <= innerWidth + 1, w: Math.round(r.width) }; })()`);
    const press = async (sel, at, what) => { await clip(); await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`); await waitFor(`window.__copied.length === 1`, `${at}${what} copied`, 8000); return ev(`window.__copied[0]`); };
    const has = (sel, at, what) => waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, `${at}${what}`, 15000);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        const sub = await ev(`fetch('/api/board/${B}/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriber_id: 'orch', job_title: 'Orchestrator', session_name: 'o-' + ${JSON.stringify(B)} }) }).then(r => r.status)`);
        assert.ok(sub < 300);
        for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
            const at = `${w}px: `;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile });
            await Emulation.setTouchEmulationEnabled(mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
            const robot = async (sel, what) => { const r = await info(sel); assert.ok(r && r.label === 'Copy for an agent' && r.icon === 'smart_toy' && r.shown && r.inView, `${at}${what} has the named robot, in view: ${JSON.stringify(r)}`); };

            console.log(`${at}1. The agent page`);
            await load('/');
            await ev(`window.selectLiveSession('docs-bot', 'claude', 'docs-bot-id', 'local'); true`);
            await has('#live-session-view .session-title-actions > .agent-copy', at, 'the robot on the agent page');
            const ap = await press('#live-session-view .session-title-actions > .agent-copy', at, 'the agent page line');
            assert.ok(/docs-bot/.test(ap) && /\nDocs: coral-agent docs sessions, section “Session Lifecycle”$/.test(ap), at + 'the agent, then the docs: ' + JSON.stringify(ap));

            console.log(`${at}2. Needs you`);
            await load('/inbox/needs');
            await has('.inbox-folder-toolbar .agent-copy', at, 'the robot on the Needs you list');
            await robot('.inbox-folder-toolbar .agent-copy', 'Needs you');
            assert.match(await press('.inbox-folder-toolbar .agent-copy', at, 'the Needs you line'), /Needs you[\s\S]*\nDocs: coral-agent docs artifacts, section “Answer a comment the Operator sent you”$/);

            console.log(`${at}3. Saved`);
            await load('/inbox/saved');
            await has('.inbox-folder-toolbar .agent-copy', at, 'the robot on Saved');
            assert.match(await press('.inbox-folder-toolbar .agent-copy', at, 'the Saved line'), /Saved[\s\S]*\nDocs: coral-agent docs saved-messages, section “In the dashboard”$/);

            console.log(`${at}4. The Merge queue working mode`);
            await ev(`import(${S} + 'team_settings_page.js').then(m => m.showTeamSettingsPage(${JSON.stringify(B)}, { page: (document.getElementById('pin-host') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pin-host' }))) })).then(() => true)`);
            await waitFor(`!!document.querySelector('#team-settings-workspace .sv[data-ready]')`, `${at}the Team settings`, 15000);
            const set = v => ev(`(() => { const s = document.querySelector('#team-settings-workspace .sv-row[data-key="mode"] select'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
            assert.equal(await set('none'), 'none');
            assert.equal(await ev(`!!document.querySelector('#team-settings-workspace .working-mode-desc ~ .agent-copy:not([hidden])')`), false, at + 'no merge queue robot for another mode');
            assert.equal(await set('merge_queue'), 'merge_queue', at + 'the preset is offered');
            await waitFor(`!!document.querySelector('#team-settings-workspace .working-mode-desc ~ .agent-copy:not([hidden])')`, `${at}the robot for the Merge queue mode`, 8000);
            assert.match(await press('#team-settings-workspace .working-mode-desc ~ .agent-copy', at, 'the Merge queue line'), new RegExp(`${B}[\\s\\S]*Merge queue[\\s\\S]*\\nDocs: coral-agent docs merge-queue, section “For an agent that makes a change”$`));

            console.log(`${at}5. The main Settings sections`);
            await load('/');
            await ev(`(async () => { await window.showSettingsModal('network'); return true; })()`);
            await has('#settings-modal .settings-pane[data-group="network"] > .agent-copy-hrow > .agent-copy', at, 'the robot on Network and Hub');
            await robot('#settings-modal .settings-pane[data-group="network"] > .agent-copy-hrow > .agent-copy', 'Network and Hub');
            assert.match(await press('#settings-modal .settings-pane[data-group="network"] > .agent-copy-hrow > .agent-copy', at, 'the Network and Hub line'), /Network and Hub[\s\S]*\nDocs: coral-agent docs hub, section “Registry \(hub only\)”$/);
            const panes = await ev(`[...document.querySelectorAll('#settings-modal .settings-pane[data-group]')].filter(p => !p.querySelector(':scope > .agent-copy-hrow > .agent-copy')).map(p => p.dataset.group)`);
            assert.deepEqual(panes, [], at + 'every section has one: ' + panes);
            await ev(`(async () => { await window.showSettingsModal('notifications'); return true; })()`);
            assert.match(await press('#settings-modal .settings-pane[data-group="notifications"] > .agent-copy-hrow > .agent-copy', at, 'the Notifications line'), /\nDocs: coral-agent docs notifications, section “Create Notification”$/);
        }
        console.log('PASS agent copy places');
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
