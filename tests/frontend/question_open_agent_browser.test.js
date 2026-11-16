// #18809: the opened question offers an open icon beside its asking agent.
// Mock-agent harness; solo display name and same-named members of different teams, desktop/phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const width of [1280, 390]) {
            await Emulation.setDeviceMetricsOverride({ width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
            await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
            await ev(`(() => {
                window.__m.add('solo', 'S', 3, { display_name: 'Getting started', sleeping: false });
                window.__m.add('wrong-member', 'W', 3, { board_project: 'other-team', board_subscriber_id: 'QA', sleeping: false });
                window.__m.add('right-member', 'R', 3, { board_project: 'question-team', board_subscriber_id: 'QA', sleeping: false });
                const select = window.selectLiveSession;
                window.__opened = null;
                window.selectLiveSession = (...args) => { window.__opened = args; return select(...args); };
                return true;
            })()`);
            for (const [kind, asker, board, session] of [['agent', 'Getting started', '', 'solo-id'], ['ask', 'QA', 'question-team', 'right-member-id']]) {
                await ev(`(async () => {
                    window.__opened = null; window.switchNavTab('hub-inbox');
                    const m = await import((window.__coralStatic || '/static/') + 'operator_asks.js');
                    await m.openAskDialog({ kind: '${kind}', asker: '${asker}', board: '${board}', session_id: '${kind === 'agent' ? session : ''}', id: 71, at: new Date().toISOString(), text: 'Open Settings and look around.' });
                    return true;
                })()`);
                const button = `document.querySelector('dialog.inbox-ask-dialog h2 .inbox-ask-open-agent')`;
                await waitFor(`!!document.querySelector('dialog.inbox-ask-dialog')`, `${width}: question opens`, 8000);
                let missing;
                try { await waitFor(`!!${button}`, `${width} ${kind}: Open agent is offered`, 6000); } catch (e) { missing = e; }
                if (process.env.CORAL_SCREENSHOT_DIR) {
                    fs.mkdirSync(process.env.CORAL_SCREENSHOT_DIR, { recursive: true });
                    fs.writeFileSync(path.join(process.env.CORAL_SCREENSHOT_DIR, `question-agent-${width}-${kind}.png`), Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
                }
                if (missing) throw missing;
                assert.equal(await ev(`${button}.getAttribute('aria-label')`), `Open ${asker}`);
                assert.equal(await ev(`${button}.querySelector('[aria-hidden="true"]').textContent`), 'open_in_new');
                assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog .inbox-ask-sub [data-agent-link]')`), false, 'the separate button is removed');
                assert.equal(await ev(`${button}.dataset.agentLink`), session, 'the question identifies its own agent');
                const reachable = await ev(`(() => { const b = ${button}; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === b || b.contains(hit); })()`);
                assert.equal(reachable, true, `${width}: action can be clicked`);
                await ev(`${button}.click(); true`);
                await waitFor(`window.__opened?.[2] === '${session}'`, `${width}: asking agent selected`, 6000);
                assert.equal(await ev(`!!document.querySelector('dialog.inbox-ask-dialog[open]')`), false, 'chat is not behind the question');
                await ev(`document.querySelector('dialog.inbox-ask-dialog')?.remove(); true`);
            }
        }
        console.log('PASS question Open agent selects the solo asker and the correct team member on desktop and phone');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
