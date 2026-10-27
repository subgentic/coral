// The Tasks table's Assigned to column is circles, not words (#8492, the operator): the person responsible as one solid circle, then the reviewers as smaller outlined circles (two, then "+N"), and nothing else;
// the whole cell is one image named in words ("Done by Dev, reviewed by QA"), which is also its hover text, so the column is as narrow as its circles. Seeded team with the Tasks answered by the suite, at 1280 and 390
// (CORAL_SCREENSHOT_DIR keeps a shot of each). Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { install: installTP, seed, openTeam, goTab } = require('./helpers/team_page');
const { removeBoards } = require('./helpers/board_cleanup');
const BASE = require('./test_base').BASE;
const TEAM = `qa-who8492-${Date.now() % 100000}`;
const SHOTS = process.env.CORAL_SCREENSHOT_DIR;
(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const { settle } = require('./helpers/wait').bind(ev);
    const shot = async n => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/${n}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    const T = (id, title, status, extra) => ({ id, title, status, priority: 'medium', created_by: 'Orchestrator', created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-26T09:00:00Z', ...extra });
    const TASKS = [T(11, 'Pick the release date', 'pending', { assigned_to: null }), T(12, 'Fix the focus ring', 'in_progress', { assigned_to: 'Frontend Dev' }),
        T(13, 'Review the filter', 'review_pending', { assigned_to: 'Orchestrator', review_requested: true, worked_by: 'Frontend Dev', reviewers: ['QA Engineer', 'UI/UX', 'Security Reviewer'] }),
        T(14, 'Settings forms 6 to 9', 'completed', { assigned_to: 'Orchestrator', completed_by: 'Orchestrator', worked_by: 'Data Science & Dashboarding', reviewers: ['QA Engineer'] }),
        T(15, 'Write the release notes', 'completed', { assigned_to: 'Backend Dev', completed_by: 'Backend Dev', worked_by: 'Backend Dev' })];
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [tag, w, h, mobile] of [['1280', 1280, 800, false], ['390', 390, 844, true]]) {
            await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
            await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await ev(`window.__coralReady.then(() => true)`); await installTP(ev);
            await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.clearCustomThemeVars(); sc.applyTheme('dark'); return true; })()`);
            await seed(ev, TEAM); if (mobile) await ev(`window.syncMobileAgentList && window.syncMobileAgentList(); true`);
            await ev(`(() => { const real = window.fetch; window.fetch = (u, o = {}) => { const p = new URL(String(u), location.href); if (/\\/api\\/board\\/[^/]+\\/tasks$/.test(p.pathname) && (!o.method || o.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({ tasks: ${JSON.stringify(TASKS)}, next_cursor: '', total_open: 3, total_completed: 2 }), { status: 200, headers: { 'content-type': 'application/json' } })); return real(u, o); }; return true; })()`);
            await openTeam(ev, waitFor, TEAM).catch(() => {});
            await goTab(ev, settle, 'Tasks'); await waitFor(`document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-primary').length >= 3`, 'tasks', 10000); await ev(`(() => { const b = [...document.querySelectorAll('[role=tabpanel]:not([hidden]) button, [role=tabpanel]:not([hidden]) option')].find(x => /^All\\b/.test(x.textContent.trim())); if (b && b.tagName === 'BUTTON') b.click(); return !!b; })()`); await waitFor(`document.querySelectorAll('[role=tabpanel]:not([hidden]) .dt-primary').length >= 5`, 'all five tasks', 10000); await settle(500);
            const cells = await ev(`[...document.querySelectorAll('[role=tabpanel]:not([hidden]) tbody tr')].map(r => { const c = r.querySelector('td[data-key="who"]'), i = c.querySelector('[role=img]'); return { title: ((r.querySelector('.dt-title-cell').title.match(/#\\d+/) || [''])[0] + ' ' + r.querySelector('.dt-title-cell').textContent), label: i ? i.getAttribute('aria-label') : null, hover: i ? i.title : null, text: i ? '' : c.textContent.trim(), solid: c.querySelectorAll('.dt-avatar:not(.dt-avatar-review)').length, outlined: c.querySelectorAll('.dt-avatar-review').length, more: (c.querySelector('.dt-avatars-more') || {}).textContent || '', words: !!c.querySelector('.dt-person-name'), w: Math.round(c.getBoundingClientRect().width) }; })`);
            const by = id => cells.find(c => c.title.startsWith('#' + id + ' '));
            assert.deepEqual([by(11).text, by(11).solid], ['Nobody yet', 0], `${tag}: nobody is said in words, no circle: ${JSON.stringify(by(11))}`);
            const one = by(12); assert.deepEqual([one.label, one.hover, one.solid, one.outlined, one.words], ['Frontend Dev', 'Frontend Dev', 1, 0, false], `${tag}: an assignee is one circle named in words: ${JSON.stringify(one)}`);
            const review = by(13); assert.deepEqual([review.label, review.solid, review.outlined, review.more], ['Frontend Dev, review by QA Engineer, UI/UX, Security Reviewer', 1, 2, '+1'], `${tag}: the person, two outlined reviewers and +1: ${JSON.stringify(review)}`);
            const done = by(14); assert.deepEqual([done.label, done.hover, done.solid, done.outlined], ['Done by Data Science & Dashboarding, reviewed by QA Engineer', 'Done by Data Science & Dashboarding, reviewed by QA Engineer', 1, 1], `${tag}: a done task names who did it, then who reviewed it: ${JSON.stringify(done)}`);
            assert.equal(by(15).label, 'Done by Backend Dev', `${tag}: no reviewers, nothing added`);
            if (!mobile) { assert.ok(Math.max(...cells.map(c => c.w)) <= 110, `${tag}: the column is at most 110 px, about 96 (${Math.max(...cells.map(c => c.w))} px)`); assert.equal(await ev(`document.querySelector('[role=tabpanel]:not([hidden]) th[data-key="who"]').textContent.replace(/[^A-Za-z]/g, '')`), 'Who', 'the head says Who'); }
            assert.ok(cells.every(c => !c.words), `${tag}: no name written beside a circle`);
            await shot('tasks-who-' + tag);
            await ev(`(async () => { const sc = await import((window.__coralStatic || '/static/') + 'settings_core.js'); sc.applyTheme('light'); return true; })()`); await settle(400); await shot('tasks-who-' + tag + '-light');
        }
    } finally { await removeBoards(ev, [TEAM]).catch(() => {}); await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
