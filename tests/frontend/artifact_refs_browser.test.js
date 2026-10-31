// A coral://artifacts/<64 hex> in team-written text is a link to that artifact (#11416): a task's Description and Result on its page, an agent's own task in the dialog, a goal's Outcome and Done when. Each is shown
// as text with the reference made a link (the label "artifact 71c21f0b", the full reference as the tooltip) that a plain click opens in the in-app viewer; a ')' or ':' after it stays text; 65 hex digits are no reference;
// hostile text beside the link (a tag, an image with a handler, a quote that tries to leave an attribute) stays text and does nothing. The board, goal and tasks are real. At 1280 px and 390 px. Drives Chrome over CDP.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { removeBoards } = require('./helpers/board_cleanup');
const { coralReady } = require('./helpers/wait');

const H1 = '71c21f0b' + 'a'.repeat(56), H2 = '522d00ff' + 'b'.repeat(56), H3 = 'c0ffee00' + 'd'.repeat(56);
// the screenshot's shape ("...522d):"), a quote that tries to leave an attribute, 65 digits, markup and a handler
const HOSTILE = (n) => `Read coral://artifacts/${H1}): then <img src=x onerror="window.__pwned=1"> and coral://artifacts/${H2}"onmouseover="window.__pwned=1" but not coral://artifacts/${H3}0 or <b>bold</b> (${n})`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const api = (method, path, body) => ev(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const B = 'ar-' + Date.now().toString(36);
    const results = []; const check = (label, ok, detail) => { results.push([label, ok]); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail !== undefined ? ' - ' + detail : ''}`); if (!ok) process.exitCode = 1; };
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; const fs = require('node:fs'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    // what a surface made of the text: its links, what is left as text, and whether anything ran
    const inspect = sel => ev(`(() => { const host = document.querySelector(${JSON.stringify(sel)}); if (!host) return null; const links = [...host.querySelectorAll('a.mb-artifact-ref')]; return { links: links.map(a => ({ hex: a.dataset.artifact, label: a.textContent, title: a.title, attrs: [...a.attributes].map(x => x.name).sort().join(',') })), text: host.textContent, tags: host.querySelectorAll('img, b, script').length, pwned: window.__pwned || 0 }; })()`);
    const verify = (label, got, expectLinks) => {
        check(`${label}: ${expectLinks} references are links, the 65-digit one is not`, got && got.links.length === expectLinks && got.links.every(l => l.hex === H1 || l.hex === H2) && !got.links.some(l => l.hex === H3), JSON.stringify(got && got.links));
        check(`${label}: the label is the short name and the tooltip is the whole reference`, got && got.links.every(l => l.label === 'artifact ' + l.hex.slice(0, 8) && l.title === 'coral://artifacts/' + l.hex), JSON.stringify(got && got.links[0]));
        check(`${label}: a link has only the attributes it is built with (no handler, no style)`, got && got.links.every(l => l.attrs === 'class,data-artifact,href,rel,target,title'), JSON.stringify(got && got.links[0]));
        check(`${label}: the ')' and ':' after the link stay text, the 65-digit reference stays text`, got && got.text.includes('): then') && got.text.includes('coral://artifacts/' + H3 + '0'), got && got.text.slice(0, 160));
        check(`${label}: hostile text stays text and nothing ran`, got && got.tags === 0 && got.pwned === 0 && got.text.includes('<img src=x onerror="window.__pwned=1">') && got.text.includes('"onmouseover="window.__pwned=1"') && got.text.includes('<b>bold</b>'), got && String(got.tags + ' ' + got.pwned));
    };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const view of [{ w: 1280, h: 900, phone: false }, { w: 390, h: 844, phone: true }]) {
            const at = `${view.w}px`;
            await Emulation.setDeviceMetricsOverride({ width: view.w, height: view.h, deviceScaleFactor: 1, mobile: view.phone });
            await Emulation.setTouchEmulationEnabled({ enabled: view.phone });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install();
            await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            if (view.w === 1280) {
                for (const [id, jt] of [['orch', 'Orchestrator'], ['dev', 'Developer']]) assert.equal((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: id, job_title: jt, session_name: id + '-s' })).status, 200);
                const g = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Links in words', outcome: HOSTILE('outcome'), done_when: `Done when coral://artifacts/${H1}): <b>bold</b> (not coral://artifacts/${H3}0)` }); // a done-when is at most 300 characters: one link
                assert.equal(g.status, 201, JSON.stringify(g)); var goal = g.body.id;
                var task = (await api('POST', `/api/board/${B}/tasks`, { title: 'A task with links', body: HOSTILE('body'), created_by: 'orch', priority: 'medium', goal_id: goal, assigned_to: 'dev' })).body.id;
                assert.equal((await api('POST', `/api/board/${B}/tasks/claim`, { subscriber_id: 'dev', task_id: task })).status, 200);
                const done = await api('POST', `/api/board/${B}/tasks/${task}/complete`, { subscriber_id: 'dev', message: HOSTILE('result') });
                assert.equal(done.status, 200, JSON.stringify(done));
            }
            await ev(`window.__pwned = 0; window.openTeamPage(${JSON.stringify(B)}, { tab: 'tasks', item: ${task} }); true`);
            await waitFor(`!!document.querySelector('#team-panel-item .team-task-text, #team-panel-item .team-task-md') && /Result/.test(document.querySelector('#team-panel-item').textContent)`, `${at}: the task page`, 12000);
            await waitFor(`document.querySelectorAll('#team-panel-item a.mb-artifact-ref').length >= 4`, `${at}: the links on the task page`, 8000);
            verify(`${at} task Description`, await inspect('#team-panel-item .team-task-body'), 2);
            verify(`${at} task Result`, await inspect('#team-panel-item .team-task-facts, #team-panel-item dl'), 2);
            await shot(`artifact-links-task-${view.w}`);
            // a plain click opens the viewer; the page does not navigate
            await ev(`(() => { const R = window.fetch; window.fetch = (u, o) => String(u).includes('/api/artifacts/${H1}') && !String(u).includes('/meta') && !String(u).includes('/comments') ? Promise.resolve(new Response('# The linked report', { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.md"' } })) : R(u, o); return true; })()`);
            const before = await ev(`location.href`);
            await ev(`document.querySelector('#team-panel-item .team-task-body a.mb-artifact-ref').click(); true`);
            await waitFor(`!!document.querySelector('#artifact-viewer:not([hidden])')`, `${at}: the viewer opens on a click`, 8000);
            await waitFor(`/The linked report/.test((document.querySelector('#artifact-viewer .artifact-viewer-body') || {}).textContent || '')`, `${at}: the artifact in the viewer`, 8000);
            check(`${at}: a click opens the artifact in the in-app viewer and the page stays`, (await ev(`location.href`)) === before);
            await ev(`document.querySelector('#artifact-viewer .artifact-viewer-close').click(); true`);
            await ev(`try { localStorage.removeItem('coral-last-place'); } catch (e) {} true`);
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings');
            await ev(`window.__pwned = 0; window.openTeamPage(${JSON.stringify(B)}, { tab: 'goals', item: ${goal} }); true`);
            await waitFor(`!!document.querySelector('.goal-split') && document.querySelectorAll('.goals-facts a.mb-artifact-ref').length >= 3`, `${at}: the goal page links`, 12000);
            verify(`${at} goal Outcome and Done when`, await inspect('.goals-facts'), 3);
            await shot(`artifact-links-goal-${view.w}`);
            // an agent's own task in the dialog: its description, and its message once finished
            await ev(`(async () => { const st = window.__coralStatic || '/static/'; const { state } = await import(st + 'state.js'); window.__pwned = 0;
                state.currentAgentTasks = [{ id: 40, title: 'My own task', agent_name: 'solo', started_at: '2026-10-01T10:00:00Z', created_at: '2026-10-01T09:00:00Z', completed: false, body: ${JSON.stringify(HOSTILE('agent body'))}, completion_message: ${JSON.stringify(HOSTILE('agent message'))} }];
                window.hideTaskDetailModal(); window.showAgentTaskDetailModal(40); return true; })()`);
            await waitFor(`document.querySelectorAll('#task-detail-content a.mb-artifact-ref').length >= 2`, `${at}: the links in the task dialog`, 10000);
            verify(`${at} task dialog`, await inspect('#task-detail-content'), await ev(`document.querySelectorAll('#task-detail-content a.mb-artifact-ref').length`));
            await shot(`artifact-links-dialog-${view.w}`);
            await ev(`window.closeTeamPage && window.closeTeamPage(); try { localStorage.removeItem('coral-last-place'); } catch (e) {} true`);
        }
    } finally { await removeBoards(ev, [B]).catch(() => {}); await client.close(); }
    assert.ok(results.length > 0 && results.every(r => r[1]), 'checks failed');
})().catch(e => { console.error(e); process.exit(1); });
