// The goal page on a phone is not cluttered (#13119, the Operator: "very cluttered ... follow our common design principles"): the header holds ONE button and a More menu (the task page's rule, #9076): Add task for a
// goal with open work, Close goal for one that looks done; Change driver, Move to another team, Not yet, Copy for an agent and the other of Add task / Close goal are in More; the driver line has no button in it; the
// title is two lines at most; every target is 44 px; keyboard: the toggle opens the menu on Enter, ArrowDown moves, Escape closes it and gives the focus back. 390 px (100% and 200% text, both themes) and landscape
// 844x390. At 1280 nothing changed: the four buttons are in the header and Copy for an agent is in the line. Real boards on the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { Input } = client;
    const board = 'goal-phone-' + Date.now().toString(36);
    const TITLE = 'A goal with a title long enough that it wraps onto three lines at 390 px, with a lot more words to make sure of it';
    const api = (method, url, body) => ev(`fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(async r => ({status:r.status,body:await r.json()}))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async (url, fs16, theme) => { await Page.navigate({ url: BASE + url }); await Page.loadEventFired(); await install(); await coralReady(ev, 'startup', 'liveList', 'liveListLoaded', 'settings'); await ev(`document.documentElement.style.fontSize = '${fs16}px'; document.documentElement.setAttribute('data-theme', '${theme}'); true`); };
    const M = '#inbox-page';
    const head = () => ev(`(() => { const root = document.querySelector('${M}'), acts = root.querySelector('.goal-head-actions'), vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const btns = [...acts.querySelectorAll(':scope > button, :scope > .task-more > button')].filter(vis).map(b => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), r: Math.round(b.getBoundingClientRect().right) }));
        const h2 = root.querySelector('#goals-detail-title'), lh = parseFloat(getComputedStyle(h2).lineHeight) || parseFloat(getComputedStyle(h2).fontSize) * 1.3;
        return { btns, lineBtns: root.querySelectorAll('.goals-detail-line button').length, titleLines: Math.round(h2.getBoundingClientRect().height / lh), more: !!acts.querySelector('.task-more-btn'), vw: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
    const items = () => ev(`[...document.querySelectorAll('${M} .goal-head-actions .task-more-menu [role=menuitem]')].map(b => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), vis: b.getClientRects().length > 0 }))`);
    const key = async (k, code, vk) => { await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) }); await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/', 16, 'light');
        assert.equal((await api('POST', `/api/board/${board}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator', session_name: board })).status, 200);
        const mkGoal = async (title, done) => {
            const c = await api('POST', `/api/board/${board}/goals`, { subscriber_id: 'Operator', title, outcome: 'Less clutter', done_when: 'One button' }); assert.equal(c.status, 201);
            assert.equal((await api('PATCH', `/api/board/${board}/goals/${c.body.id}`, { subscriber_id: 'Operator', state: 'active' })).status, 200);
            const t = await api('POST', `/api/board/${board}/tasks`, { created_by: 'orch', title: 'One task ' + c.body.id, body: 'x', priority: 'medium', goal_id: c.body.id }); assert.ok(t.status < 300);
            if (done) { const all = await ev(`fetch('/api/board/${board}/tasks').then(r => r.json())`), tid = ((Array.isArray(all) ? all : all.tasks || []).find(x => x.title === 'One task ' + c.body.id) || {}).id;
                assert.ok((await api('POST', `/api/board/${board}/tasks/claim`, { subscriber_id: 'orch', task_id: tid })).status < 300);
                assert.ok((await api('POST', `/api/board/${board}/tasks/${tid}/complete`, { subscriber_id: 'orch', message: 'done', outcome: 'success' })).status < 300); }
            return c.body.id; };
        const openId = await mkGoal(TITLE, false), doneId = await mkGoal('A goal that is all done', true);
        for (const [w, h, mobile, fs16, theme, tag] of [[390, 844, true, 16, 'light', '390 px light'], [390, 844, true, 16, 'dark', '390 px dark'], [390, 844, true, 32, 'light', '390 px 200% text'], [844, 390, true, 16, 'light', 'landscape 844x390'], [1280, 900, false, 16, 'light', '1280 px']]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            const phone = w < 900 || mobile && h < 500;
            await load(`/inbox/goals/${board}/${openId}`, fs16, theme);
            await waitFor(`!!document.querySelector('${M} #goals-detail-title') && !!document.querySelector('${M} .goal-head-actions button')`, `${tag}: the goal page`, 15000);
            let p = await head();
            if (!phone) {
                assert.deepEqual(p.btns.map(b => b.t), ['Add task', 'Change driver', 'Move to another team', 'Close goal'], `${tag}: desktop keeps its four buttons ${JSON.stringify(p)}`);
                assert.equal(await ev(`!!document.querySelector('${M} .goals-detail-line .goal-copy-agent')`), true, `${tag}: Copy for an agent stays in the line on a desktop`);
                continue;
            }
            assert.deepEqual(p.btns.map(b => b.t), ['Add task', 'More'], `${tag}: one button and More: ${JSON.stringify(p)}`);
            assert.equal(p.lineBtns, 0, `${tag}: no button in the driver line`);
            assert.ok(p.titleLines <= 2, `${tag}: the title is two lines at most: ${p.titleLines}`);
            assert.ok(p.btns.every(b => b.h >= 43.5 && b.r <= p.vw), `${tag}: 44 px targets inside the screen: ${JSON.stringify(p.btns)}`);
            assert.ok(!p.sideways, `${tag}: nothing scrolls sideways`);
            assert.deepEqual((await items()).filter(i => i.vis), [], `${tag}: the menu is closed at first`);
            // keyboard: focus More, Enter opens, the first item has focus, ArrowDown moves, Escape closes and returns
            await ev(`document.querySelector('${M} .goal-head-actions .task-more-btn').focus(); true`);
            await key('Enter', 'Enter', 13);
            await waitFor(`!document.querySelector('${M} .goal-head-actions .task-more-menu').hidden`, `${tag}: More opens on Enter`, 4000);
            const open = await items();
            assert.deepEqual(open.map(i => i.t), ['Change driver', 'Move to another team', 'Copy for an agent', 'Close goal'], `${tag}: the menu holds the rest: ${JSON.stringify(open)}`);
            assert.ok(open.every(i => i.vis && i.h >= 43.5), `${tag}: menu items are 44 px: ${JSON.stringify(open)}`);
            assert.equal(await ev(`document.activeElement.textContent.trim()`), 'Change driver', `${tag}: the first item has focus`);
            await key('ArrowDown', 'ArrowDown', 40);
            assert.equal(await ev(`document.activeElement.textContent.trim()`), 'Move to another team', `${tag}: ArrowDown moves`);
            if (w === 390 && fs16 === 16 && theme === 'light') await shot('goal-phone-menu-390');
            await key('Escape', 'Escape', 27);
            assert.equal(await ev(`document.activeElement.classList.contains('task-more-btn')`), true, `${tag}: Escape gives the focus back to More`);
            if (w === 390 && fs16 === 16) await shot(`goal-phone-390-${theme}`);
            if (fs16 === 32) await shot('goal-phone-390-200');
        }
        // a goal that looks done: Close goal is the one button
        await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await Emulation.setTouchEmulationEnabled({ enabled: true });
        await load(`/inbox/goals/${board}/${doneId}`, 16, 'light');
        await waitFor(`!!document.querySelector('${M} .goal-head-actions button')`, 'the done goal page', 15000);
        const pd = await head();
        assert.deepEqual(pd.btns.map(b => b.t), ['Close goal', 'More'], 'a goal that looks done: Close goal is the one button: ' + JSON.stringify(pd));
        await ev(`document.querySelector('${M} .goal-head-actions .task-more-btn').click(); true`);
        await waitFor(`!document.querySelector('${M} .goal-head-actions .task-more-menu').hidden`, 'More opens', 4000);
        assert.deepEqual((await items()).map(i => i.t), ['Add task', 'Not yet', 'Change driver', 'Move to another team', 'Copy for an agent'], 'and the rest are in More');
        console.log('PASS goal page on a phone: one button and More, no button in the driver line, title two lines, 44 px, keyboard, 390 (100%, 200%, both themes), landscape; 1280 unchanged');
    } finally { await removeBoards(ev, [board]).catch(() => { }); await client.close(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
