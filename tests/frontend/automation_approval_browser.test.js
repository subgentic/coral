// An automation a team's Orchestrator proposed waits for the Operator (#21505): the Needs you row shows the whole card (the facts, every step in full, the notes on what is covered and what is not) with Approve and
// Deny, one click each. The click goes to the server's claim route (which runs it against the hash the question was filed with); the page only shows the answer. The routes are stubbed with the server's shape
// (the Go tests read the real ones); a real isolated server serves the page. With CORAL_SCREENSHOT_DIR set it also writes the shots the side-by-side review compares with mock v2.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');
const { coralReady } = require('./helpers/wait');
const BASE = require('./test_base').BASE;

const HASH = '3f9a1c079d2e5a6b' + '0'.repeat(48);
const NEWER = 'b81d4e22' + '9d2e5a6b'.repeat(7); // the hash of the changed version (the first one is HASH, the one that was approved)
const PROMPT = ['Read reports/deps.json. For every dependency with a known security advisory, write one line: the package, the version we use, the fixed version, and whether the fix is a major upgrade.',
    'Then post a short summary to the team board. If nothing is vulnerable, say so in one sentence and stop.', 'Do not change any file. Do not open pull requests. Do not install anything.',
    'Keep the summary under 120 words, and name no individual.', 'If any advisory is rated critical, put that line first and start the summary with the word CRITICAL.',
    'If reports/deps.json is missing or empty, say that and stop; do not guess.', 'Ping @Operator <img src=x onerror="window.__pwned=1"> never.'].join('\n');
const view = (extra = {}) => ({ name: 'nightly-deps', description: '', team: 'team', proposed_by: 'Orchestrator', state: 'pending', enabled: false, hash: HASH, repo_path: '/Users/you/Software/web-shop', cron: '30 7 * * 1-5', timezone: 'America/Chicago', max_duration_s: 1800,
    steps: [
        { index: 1, name: 'scan', type: 'shell', command: './scripts/check_deps.sh --since yesterday --out reports/deps.json', continue_on_failure: false, file: './scripts/check_deps.sh', editable_files: false },
        { index: 2, name: 'summarize', type: 'agent', prompt: PROMPT, agent_type: 'claude', model: 'sonnet', continue_on_failure: false, editable_files: false },
        { index: 3, name: 'tidy', type: 'shell', command: 'make clean-reports', continue_on_failure: true, editable_files: true }],
    ...extra });

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    const shot = async (name, w, mobile) => { const dir = process.env.CORAL_SCREENSHOT_DIR; if (!dir) return; fs.mkdirSync(dir, { recursive: true });
        await Emulation.setDeviceMetricsOverride({ width: w, height: 2600, deviceScaleFactor: 1, mobile }); await new Promise(r => setTimeout(r, 400)); // sleep-ok: a screenshot only: the resized page needs a beat to lay out
        fs.writeFileSync(`${dir}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
        await Emulation.setDeviceMetricsOverride({ width: w, height: w === 390 ? 844 : 900, deviceScaleFactor: 1, mobile }); };
    try {
        await Page.enable(); await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
            for (const theme of w === 1440 ? ['dark', 'light'] : ['dark']) {
                await Emulation.setDeviceMetricsOverride({ width: w, height: h, deviceScaleFactor: 1, mobile }); await Emulation.setTouchEmulationEnabled({ enabled: mobile });
                await Page.navigate({ url: BASE + '/' }); await Page.loadEventFired(); await install(); await coralReady(ev);
                const at = `${w} ${theme}: `;
                await ev(`document.documentElement.setAttribute('data-theme', '${theme}'); true`);
                const ask = (changed, hash = HASH) => ({ board: 'team', kind: 'ask', id: 51, key: 51, asker: 'Coral', text: '@Operator [Coral] An automation waits for your approval: nightly-deps (team team). It starts off.\\n' + PROMPT + '\\n'.repeat(1) + 'x'.repeat(400), at: '2026-11-26T01:00:00Z',
                    buttons: [{ id: 17, label: changed ? 'Approve again' : 'Approve', action: 'approve-automation', arg: 'nightly-deps:' + hash, state: 'pending' }, { id: 18, label: 'Deny', action: 'deny-automation', arg: 'nightly-deps:' + hash, state: 'pending' }] });
                await ev(`(() => {
                    window.__asks = [${JSON.stringify(ask(false))}]; window.__claims = []; window.__view = ${JSON.stringify(view())}; window.__mode = 'approved'; const orig = window.fetch.bind(window);
                    const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
                    window.fetch = (u, o) => { const url = String(u);
                        if (url === '/api/operator-asks') return json(window.__asks);
                        if (url === '/api/board/team/automations/nightly-deps') return json({ automation: window.__view, runs: [] });
                        const m = url.match(/\\/asks\\/51\\/buttons\\/(\\d+)\\/claim$/);
                        if (m) { window.__claims.push(Number(m[1]));
                            if (window.__mode === 'changed') { window.__asks = []; return json({ code: 'automation_changed', message: 'the automation changed since this question was filed: look at the new question' }, 409); }
                            window.__asks = []; return json({ ok: true, ran: true, result: Number(m[1]) === 17 ? 'approved' : 'denied', action: Number(m[1]) === 17 ? 'approve-automation' : 'deny-automation' }); }
                        return orig(u, o); };
                    return true; })()`);
                await ev(`window.switchNavTab('hub-inbox'); true`);
                await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 1 && !!document.querySelector('[data-automation-action=approve]') && !!document.querySelector('[data-automation-card] .autoc-step')`, at + 'one row with the card, Approve and Deny', 12000);
                await new Promise(r => setTimeout(r, 400)); // sleep-ok: the list redraws once after the card is in; no state names it, so the settled row is read after a beat
                await waitFor(`!!document.querySelector('[data-automation-card] .autoc-facts')`, at + 'the card after the redraw', 8000);
                const row = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'); const card = r.querySelector('[data-automation-card]');
                    const steps = [...card.querySelectorAll('.autoc-step')].map(s => ({ head: s.querySelector('.autoc-step-head').textContent, text: s.querySelector('.autoc-text').textContent, ok: !!s.querySelector('.autoc-note-ok'), warn: !!s.querySelector('.autoc-note-warn'), note: (s.querySelector('.autoc-note') || {}).textContent || '', body: s.querySelector('.autoc-step-body').textContent }));
                    return { text: r.textContent, kind: (r.querySelector('.inbox-kind-ask') || {}).textContent, chip: (r.querySelector('[data-automation-state]') || {}).textContent, facts: card.querySelector('.autoc-facts').textContent, steps, count: card.querySelector('.autoc-steps-title').textContent, rule: card.querySelector('.autoc-rule').textContent,
                        approve: r.querySelector('[data-automation-action=approve]').textContent, deny: r.querySelector('[data-automation-action=deny]').textContent, hint: (r.querySelector('[data-automation-hint]') || {}).textContent, pwned: !!window.__pwned, imgs: card.querySelectorAll('img').length }; })()`);
                assert.equal(row.kind, 'Automation approval', at + 'the kind word');
                assert.equal(row.chip, 'Starts off', at + 'the state chip');
                assert.ok(row.text.includes('Approve an automation: nightly-deps'), at + 'the title');
                for (const f of ['nightly-deps', 'team', '/Users/you/Software/web-shop', 'Every weekday at 07:30 (Chicago time)', 'Orchestrator of team', HASH.slice(0, 16), 'covers every step below, the schedule and the folder']) assert.ok(row.facts.includes(f), at + 'a fact: ' + f);
                assert.equal(row.count, '3 steps, in order', at + 'the step count');
                assert.equal(row.steps.length, 3, at + 'three steps');
                assert.ok(row.steps[0].head.includes('Step 1') && row.steps[0].head.includes('Shell') && row.steps[0].head.includes('stops the run if it fails'), at + 'step 1 head: ' + row.steps[0].head);
                assert.equal(row.steps[0].text, './scripts/check_deps.sh --since yesterday --out reports/deps.json', at + 'step 1 command whole');
                assert.ok(row.steps[0].ok && !row.steps[0].warn && row.steps[0].note.includes('./scripts/check_deps.sh') && row.steps[0].note.includes('is part of this approval; if it changes, the run stops and you are asked again. It covers this file only, not what the file runs.'), at + 'step 1 has the green line: ' + row.steps[0].note);
                assert.ok(row.steps[1].head.includes('Agent') && row.steps[1].body.includes('Agent typeClaude') && row.steps[1].body.includes('ModelSonnet') && !row.steps[1].body.includes('sonnet'), at + 'step 2 agent type and model');
                assert.equal(row.steps[1].text, PROMPT, at + 'step 2 prompt whole, to the last character');
                assert.ok(!row.steps[1].ok && !row.steps[1].warn, at + 'an agent step has neither note');
                assert.ok(row.steps[2].head.includes('keeps going if it fails'), at + 'step 3 head');
                assert.ok(row.steps[2].warn && !row.steps[2].ok && row.steps[2].note.includes('Runs files your team can change after you approve'), at + 'only step 3 has the amber line: ' + row.steps[2].note);
                assert.ok(row.rule.includes('Approving enables exactly this version; any later edit turns it off and asks you again.'), at + 'the rule line');
                assert.equal(row.approve, 'Approve'); assert.equal(row.deny, 'Deny');
                assert.ok(row.hint.includes('Deny removes the proposal. Only you can approve it, on this computer: a Hub link cannot.'), at + 'the hint under the buttons: ' + row.hint);
                assert.equal(row.pwned, false, at + 'nothing the Orchestrator wrote ran'); assert.equal(row.imgs, 0, at + 'its markup is text');
                const box = await ev(`(() => { const pre = document.querySelectorAll('.autoc-text')[1]; const cs = getComputedStyle(pre); return { scrolls: cs.overflowY === 'auto' && pre.scrollHeight > pre.clientHeight, hint: !!document.querySelectorAll('.autoc-step')[1].querySelector('.autoc-hint'), fits: document.documentElement.scrollWidth <= window.innerWidth + 1 }; })()`);
                assert.ok(box.scrolls, at + 'a long prompt scrolls inside its box'); assert.ok(box.hint, at + 'and says so'); assert.ok(box.fits, at + 'no horizontal scroll');
                // the footer and the green path (QA2 round 1): nothing runs off the card's edge; the path is one piece; at 390 Approve and Deny are wide
                const foot = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'), right = n => n.getBoundingClientRect().right, edge = r.getBoundingClientRect().right + 1, h = r.querySelector('[data-automation-hint]'), ap = r.querySelector('[data-automation-action=approve]'), dn = r.querySelector('[data-automation-action=deny]'), code = r.querySelector('.autoc-note-ok code'), cs = getComputedStyle(code); return { hintIn: right(h) <= edge && h.scrollWidth <= h.clientWidth + 1, btnsIn: right(ap) <= edge && right(dn) <= edge, apW: ap.getBoundingClientRect().width, dnW: dn.getBoundingClientRect().width, dbg: (() => { const p = ap.parentElement, c = getComputedStyle(p), a = getComputedStyle(ap); return [p.className, c.display, c.flexWrap, c.width, a.flexBasis, a.flexGrow, a.width, p.getBoundingClientRect().width].join('|'); })(), pathOne: code.getClientRects().length === 1 && cs.whiteSpace === 'nowrap' && code.getBoundingClientRect().height < 30 }; })()`);
                assert.ok(foot.hintIn, at + 'the note under the buttons is inside the card'); assert.ok(foot.btnsIn, at + 'the buttons are inside the card'); assert.ok(foot.pathOne, at + 'the script path stays whole on one line');
                if (w === 390) assert.ok(foot.apW >= 120 && foot.dnW >= 120, at + `Approve and Deny are wide buttons at 390: ${foot.apW} ${foot.dnW} ${foot.dbg}`);
                await shot(`asking-${w}-${theme}`, w, mobile);
                if (theme === 'dark' || w === 390) {
                    // Approve: one click, one claim of the Approve button, the row goes
                    await ev(`document.querySelector('[data-automation-action=approve]').click(); true`);
                    await waitFor(`window.__claims.length === 1`, at + 'the claim was sent', 8000);
                    assert.deepEqual(await ev(`window.__claims`), [17], at + 'the Approve button (17) was claimed, once');
                    await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0`, at + 'the answered row leaves Needs you', 8000);
                    // changed since approved: the state, the diff, Approve again
                    const changedView = view({ state: 'changed', approved_hash: HASH, hash: NEWER, changes: ['- Step 2 · model: sonnet', '+ Step 2 · model: opus', '- Schedule: 30 7 * * 1-5 America/Chicago', '+ Schedule: 30 7 * * * America/Chicago'] });
                    await ev(`window.__claims = []; window.__mode = 'approved'; window.__view = ${JSON.stringify(changedView)}; window.__asks = [${JSON.stringify(ask(true, NEWER))}]; true`);
                    await ev(`import((window.__coralStatic || '/static/') + 'operator_asks.js').then(m => m.refreshOperatorAsks(true)).then(() => true)`);
                    await waitFor(`!!document.querySelector('[data-automation-action=approve]') && !!document.querySelector('[data-automation-card] .autoc-changed')`, at + 'the changed card', 8000);
                    const ch = await ev(`(() => { const r = document.querySelector('#group-table-view tbody tr'); return { chip: r.querySelector('[data-automation-state]').textContent, title: r.textContent, changed: r.querySelector('.autoc-changed').textContent, adds: r.querySelectorAll('.autoc-diff .a').length, dels: r.querySelectorAll('.autoc-diff .d').length, approve: r.querySelector('[data-automation-action=approve]').textContent, hint: r.querySelector('[data-automation-hint]').textContent }; })()`);
                    assert.equal(ch.chip, 'Off until you approve again', at + 'the changed chip'); assert.ok(ch.title.includes('Changed since you approved: nightly-deps'), at + 'the changed title');
                    assert.ok(ch.changed.includes('What changed since you approved') && ch.changed.includes(HASH.slice(0, 8)) && ch.changed.includes(NEWER.slice(0, 8)) && ch.changed.includes('nothing ran from this version'), at + 'what changed: ' + ch.changed);
                    assert.equal(ch.adds, 2); assert.equal(ch.dels, 2); assert.equal(ch.approve, 'Approve again');
                    assert.ok(ch.changed.includes('Schedule: Every weekday at 07:30 (Chicago time)') && ch.changed.includes('Schedule: Every day at 07:30 (Chicago time)') && ch.changed.includes('Step 2 \u00b7 Model: Sonnet') && ch.changed.includes('Step 2 \u00b7 Model: Opus') && !/\* \*|model:/.test(ch.changed), at + 'what changed is in words, no cron: ' + ch.changed);
                    assert.ok(ch.hint.includes('Deny keeps it off. You can approve it later from Automations.'), at + 'the changed hint');
                    await shot(`changed-${w}-${theme}`, w, mobile);
                    // an automation that changed behind the question: the server refuses and the page drops the row
                    await ev(`window.__mode = 'changed'; true`);
                    await ev(`document.querySelector('[data-automation-action=approve]').click(); true`);
                    await waitFor(`document.querySelectorAll('#group-table-view tbody tr').length === 0`, at + 'a changed automation leaves no stale Approve', 8000);
                }
            }
        }
        console.log('PASS an automation is approved or denied from its Needs you row, with every step shown whole');
    } finally { await client.close(); }
})().catch(e => { console.error(e); process.exit(1); });
