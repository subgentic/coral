// Goals-screen comment composer is visible, takes native typing and posts through real routes at desktop and 390 (#13630).
const assert = require('node:assert/strict');
const { connect } = require('./agent_view_harness');
const { removeBoards } = require('./helpers/board_cleanup');
const path = require('node:path');
const { sqliteText, sqliteExec } = require('./helpers/sqlite.js');
const BASE = require('./test_base').BASE;
const { coralReady } = require('./helpers/wait');
const DATA = process.env.CORAL_TEST_DATA_DIR || '';
// The first comment anyone writes on a computer makes its comment identity, a row in user_settings (artifact_comments_owner_id). This suite is often that first writer on a shared server: when the row was
// not there at the start it is removed at the end, so the suite leaves the server as it found it whoever runs it (the runner does the same after each suite; this does not depend on it, #13341).
const OWNER_KEY = 'artifact_comments_owner_id';
const ownerRowExists = () => { try { return sqliteText(path.join(DATA, 'sessions.db'), `SELECT 1 FROM user_settings WHERE key = '${OWNER_KEY}';`).trim() !== ''; } catch { return null; } };


(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const hadOwnerRow = DATA ? ownerRowExists() : null;
    const B = 'goal-compose-' + Date.now().toString(36), failures = [];
    const api = (method, p, body) => ev(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))`);
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; require('node:fs').mkdirSync(d, { recursive: true }); require('node:fs').writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const load = async route => { await Page.navigate({ url: BASE + route }); await Page.loadEventFired(); await install(); await coralReady(ev); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        await load('/');
        assert.ok((await api('POST', `/api/board/${B}/subscribe`, { subscriber_id: 'orch', job_title: 'Orchestrator' })).status < 300);
        const made = await api('POST', `/api/board/${B}/goals`, { subscriber_id: 'Operator', title: 'Composer regression goal', outcome: 'Comments reach the owner', done_when: 'Comments can be sent' });
        assert.equal(made.status, 201, JSON.stringify(made));
        const G = made.body.id || made.body.goal?.id;
        for (const width of [1280, 390]) {
            try {
                await Emulation.setDeviceMetricsOverride({ width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
                await Emulation.setTouchEmulationEnabled({ enabled: width === 390 });
                await load('/inbox/goals');
                await ev(`localStorage.setItem('coral-artifact-comments-open', 'closed'); true`);
                const row = `[...document.querySelectorAll('#group-table-view .dt-primary')].find(e => e.textContent.includes('Composer regression goal'))`;
                await waitFor(`!!(${row})`, `${width}: goal in Goals screen`, 15000);
                await ev(`${row}.click(); true`);
                await waitFor(`!!document.getElementById('goal-tab-comments')`, `${width}: goal page`, 10000);
                await ev(`document.getElementById('goal-tab-comments').click(); true`);
                await waitFor(`!!document.querySelector('.goal-comments .ac-whole')`, `${width}: Comment on this goal`, 10000);
                await shot(`goal-compose-${width}-before-click`);
                console.log(width + ' panel ' + await ev(`JSON.stringify({ inert: document.querySelector('.goal-comments .ac-panel').inert, locked: !!document.querySelector('.goal-comments .ac-locked') })`));
                const whole = await ev(`(() => { const b = document.querySelector('.goal-comments .ac-whole'); b.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', ...whole, button: 'left', clickCount: 1 });
                await client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...whole, button: 'left', clickCount: 1 });
                await waitFor(`!!document.querySelector('.goal-comments .ac-input')`, `${width}: composer created`, 5000);
                await shot(`goal-compose-${width}-editor`);
                const geometry = await ev(`(() => { const t = document.querySelector('.goal-comments .ac-input'); t.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = t.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const ancestors = []; for (let e = t; e; e = e.parentElement) { const b = e.getBoundingClientRect(), s = getComputedStyle(e); ancestors.push({ tag: e.tagName, cls: e.className, h: b.height, overflow: s.overflow, display: s.display }); } return { w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2, hit: hit === t, hitName: hit?.tagName + "." + hit?.className, disabled: t.disabled, ancestors }; })()`);
                console.log(width + ' geometry ' + JSON.stringify(geometry));
                assert.ok(geometry.w > 100 && geometry.h >= 48 && geometry.hit && !geometry.disabled, `${width}: goal composer is visible and accepts pointer input: ${JSON.stringify(geometry)}`);
                const comment = `Goal comment sent at ${width}`;
                await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 });
                await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 });
                await client.Input.insertText({ text: comment });
                assert.equal(await ev(`document.querySelector('.goal-comments .ac-input').value`), comment, `${width}: native typing reaches textarea`);
                await ev(`document.querySelector('.goal-comments .ac-send').click(); true`);
                await waitFor(`document.querySelector('.goal-comments .ac-list')?.textContent.includes(${JSON.stringify(comment)})`, `${width}: sent comment shown`, 10000);
                const listed = await api('GET', `/api/artifacts/goal:${B}:${G}/comments`);
                assert.ok(listed.body.comments.some(c => c.body === comment), `${width}: server stored comment`);
                assert.ok(!await ev(`document.querySelector('.goal-comments').textContent.includes('this file') || document.querySelector('.goal-comments .ac-lock')?.title.includes('this file')`), `${width}: goal lock explanation names the goal`);
                await shot(`goal-compose-${width}-sent`);
            } catch (e) { failures.push(e.message); console.error(e.stack); }
        }
        assert.deepEqual(failures, []);
    } finally {
        await removeBoards(ev, [B]).catch(() => {}); await client.close();
        if (hadOwnerRow === false && ownerRowExists()) { try { sqliteExec(path.join(DATA, 'sessions.db'), `PRAGMA busy_timeout = 5000; DELETE FROM user_settings WHERE key = '${OWNER_KEY}';`); } catch (e) { console.error(e.message); } }
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
