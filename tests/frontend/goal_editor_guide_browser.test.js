// The New goal screen, part 3: the Guide rail (#12724, direction A). As the person types it says, by the board's own rules and with no model or agent asked: whether the title is one outcome (not two things, not a
// release or a team, not broad), whether the done-when can be checked (chips under it), and how big the goal looks (the steps listed, 2 to 15). It sits at the right on a desktop and under the writing on a phone,
// the summary is said once through a status region, and an example fills the done-when. 1280, 390 and 200% text.
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');

const STUB = `(() => { const R = window.fetch; const json = (b, s = 200) => Promise.resolve(new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (u, o) => { const url = new URL(String(u), location.href); window.__asked = (window.__asked || 0) + (/\\/api\\/(agent|models?|llm|chat|suggest)/.test(url.pathname) ? 1 : 0);
        if (/\\/api\\/board\\/[^/]+\\/subscribers/.test(url.pathname)) return json([{ subscriber_id: 'Lead-agent', job_title: 'Orchestrator', session_name: 'lead' }]);
        return R(u, o); }; })();`;

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const problems = [];
    const check = (label, cond, detail) => { if (!cond) problems.push(`${label}${detail !== undefined ? ': ' + detail : ''}`); };
    const shot = async n => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const set = (id, v) => ev(`(() => { const e = document.getElementById('${id}'); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const checks = () => ev(`Object.fromEntries([...document.querySelectorAll('.goal-check')].map(c => [c.dataset.check, [c.className.replace('goal-check goal-check-', ''), c.querySelector('b').textContent]]))`);
    const chips = () => ev(`[...document.querySelectorAll('.goal-done-sign')].map(c => c.textContent)`);
    const box = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width) }; })()`);
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD }); await Page.addScriptToEvaluateOnNewDocument({ source: STUB });
        for (const [w, h, mobile, fs] of [[1280, 900, false, 16], [390, 844, true, 16], [390, 844, true, 32]]) {
            const tag = `${w} px ${fs === 32 ? '200% text' : '100%'}`;
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'settings');
            await ev(`document.documentElement.style.fontSize = '${fs}px'; import((window.__coralStatic || '/static/') + 'goal_editor.js').then(m => { m.openGoalEditor({ project: 'team-a' }); return true; })`);
            await waitFor(`!!document.querySelector('.goal-editor .goal-rail') && !document.querySelector('#goal-new-driver').disabled`, `${tag}: the screen and its Guide`, 8000);

            // empty: asks for the words, warns of nothing
            let c = await checks();
            check(`${tag}: nothing typed: todo, not a warning`, c.one && c.one[0] === 'todo' && c.done && c.done[0] === 'todo' && (await ev(`document.querySelector('.goal-guide-summary').dataset.looks`)) === '0', JSON.stringify(c));
            // where it sits
            const main = await box('.goal-writing'), rail = await box('.goal-rail'), out = await box('#goal-new-description');
            if (!mobile) check(`${tag}: the Guide is at the right of the writing`, rail.l >= main.r - 4 && rail.t < 200, JSON.stringify({ main, rail }));
            else check(`${tag}: on a phone the Guide is under the writing`, rail.t >= out.b && rail.w >= 300 / (fs === 32 ? 1 : 1) * 0 + 1, JSON.stringify({ out, rail }));

            // one outcome, live
            await set('goal-new-title', 'Customers import a CSV on their own'); c = await checks();
            check(`${tag}: a plain title is one outcome`, c.one[0] === 'ok', JSON.stringify(c));
            await set('goal-new-title', 'CSV import plus Notion import'); c = await checks();
            check(`${tag}: "plus" is more than one outcome, at once`, c.one[0] === 'warn' && /more than one/.test(c.one[1]), JSON.stringify(c));
            await set('goal-new-title', 'Release v1.4'); c = await checks();
            check(`${tag}: a release is named as one`, c.one[0] === 'warn' && /release/i.test(c.one[1]), JSON.stringify(c));
            await set('goal-new-title', 'Customers import a CSV on their own');
            // done when
            await set('goal-new-done', 'It works well'); c = await checks();
            check(`${tag}: a feeling is not a check`, c.done[0] === 'warn' && /hard to check/i.test(c.done[1]) && (await chips()).join('|') === 'Hard to check|No number', JSON.stringify([c, await chips()]));
            await set('goal-new-done', 'A customer imports a 10,000-row CSV and sees every row in under a minute'); c = await checks();
            check(`${tag}: a number and something to see passes`, c.done[0] === 'ok' && (await chips()).join('|') === 'Checkable|Has a number', JSON.stringify([c, await chips()]));
            // size
            await set('goal-new-description', '- read the file\n- show progress\n- list failed rows');
            check(`${tag}: three steps is about three tasks`, /About 3 tasks/.test(await ev(`document.querySelector('.goal-size-words').textContent`)) && (await ev(`document.querySelector('.goal-meter').dataset.state`)) === 'ok');
            await set('goal-new-description', Array.from({ length: 16 }, (_, i) => `- step ${i}`).join('\n'));
            check(`${tag}: sixteen steps is too many`, (await ev(`document.querySelector('.goal-meter').dataset.state`)) === 'warn' && /Split it/.test(await ev(`document.querySelector('.goal-size-words').textContent`)));
            // the summary is said once, a moment later
            await set('goal-new-title', 'Add search plus filters'); await set('goal-new-done', 'Feels good');
            await new Promise(r => setTimeout(r, 900)); // sleep-ok: the summary is said after a pause, with no event
            check(`${tag}: the summary counts what to look at`, (await ev(`document.querySelector('.goal-guide-summary').textContent`)) === '3 things to look at', await ev(`document.querySelector('.goal-guide-summary').textContent + ' / ' + JSON.stringify([...document.querySelectorAll('.goal-check')].map(c => c.className))`));
            check(`${tag}: the summary is a status region`, (await ev(`(() => { const s = document.querySelector('.goal-guide-summary'); return s.getAttribute('role') + '/' + s.getAttribute('aria-live'); })()`)) === 'status/polite');
            // an example fills the done-when
            await set('goal-new-done', ''); await ev(`document.querySelector('.goal-example').click(); true`);
            check(`${tag}: an example fills the done-when and the Guide follows`, /^A person can open Settings/.test(await ev(`document.getElementById('goal-new-done').value`)) && (await checks()).done[0] === 'ok');
            if (mobile && fs === 16) { await ev(`document.querySelector('.goal-guide').scrollIntoView({ block: 'start' }); true`); const sc = await ev(`(() => { const d = document.querySelector('dialog.goal-editor'), m = document.querySelector('.goal-writing'), a = document.querySelector('.goals-actions').getBoundingClientRect(); return { dialogScrolled: d.scrollTop, mainScrolled: m.scrollTop, actionsBottom: Math.round(a.bottom), vh: innerHeight }; })()`); check(`${tag}: the writing scrolls inside the screen and the actions stay pinned at the bottom`, sc.dialogScrolled === 0 && sc.mainScrolled > 0 && sc.actionsBottom >= sc.vh - 8, JSON.stringify(sc)); await ev(`document.querySelector('.goal-writing').scrollTop = 0; true`); }
            check(`${tag}: nothing scrolls sideways`, (await ev(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0 && (await ev(`(() => { const d = document.querySelector('dialog.goal-editor'); return d.scrollWidth - d.clientWidth; })()`)) <= 1);
            check(`${tag}: no model or agent call was made`, (await ev(`window.__asked || 0`)) === 0);
            if (fs === 16) { await set('goal-new-title', 'Importer is live for every customer'); await set('goal-new-description', 'Customers can bring their data into Coral from a CSV file and also from Notion.\n- The import runs in the background\n- Rows that fail are listed'); await set('goal-new-done', 'A new customer imports a 10,000-row CSV and sees every row in under a minute'); await new Promise(r => setTimeout(r, 800)); await shot(`guide-${w}`); } // sleep-ok: the summary is said after a pause
        }
    } finally { await client.close(); }
    assert.deepEqual(problems, [], 'the New goal screen, the Guide:\n  ' + problems.join('\n  '));
    console.log('PASS the New goal screen: the Guide follows the words, at 1280, 390 and 200% text');
})().catch(e => { console.error(e); process.exit(1); });
