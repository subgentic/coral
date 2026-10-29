// #5237 (operator) wanted the branch and model lines of "Show branches" and "Show model" in a team group's rows too; since #9686 (slice B, UI/UX #9358) no agent row draws them, anywhere: a row is one line (the dot, the name, at most one chip) and
// the switches are gone, so this suite now pins the same promise the other way: the four rows of a team group are the same one line as every other row, with no goal, model or branch line (Show summary and Show model are off by default again, #10816, and add a line only when on) and no Display switch for the others, and what the lines said (the
// branch, the model) is in the row's hover tip for every agent that has it and for none that has not. Drives Chrome over CDP through agent_view_harness.js against the isolated dev server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { connect } = require('./agent_view_harness');

(async () => {
    const { client, Page, Emulation, ev, waitFor, PRELOAD, install } = await connect();
    // CORAL_SCREENSHOT_DIR: a picture of each view (for review).
    const shot = async name => { const d = process.env.CORAL_SCREENSHOT_DIR; if (!d) return; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(`${d}/${name}.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64')); };
    try {
        await Page.enable();
        await Page.addScriptToEvaluateOnNewDocument({ source: PRELOAD });
        // A team of four on one board: an agent on its own worktree, one on the shared checkout (a branch, no worktree), one with a model but no git folder, one with nothing on record.
        const scene = () => ev(`(async () => {
            T.state.liveSessions = []; window.__m.agents = {};
            for (const n of ['wt-agent', 'shared-agent', 'nogit-agent', 'bare-agent']) window.__m.add(n, n.slice(0, 1).toUpperCase(), 3, { sleeping: false, board_project: 'team-x' });
            const by = n => T.state.liveSessions.find(s => s.name === n);
            Object.assign(by('wt-agent'), { branch: 'fix/login', git_state: { is_worktree: true, base_branch: 'main' }, model: 'claude-opus-4-1' });
            Object.assign(by('shared-agent'), { branch: 'main', model: 'claude-sonnet-4-5' });
            Object.assign(by('nogit-agent'), { model: 'claude-opus-4-1' });
            T.render.renderLiveSessions(T.state.liveSessions); return T.state.liveSessions.length; })()`);
        const load = async view => {
            await Emulation.setDeviceMetricsOverride({ width: view.width, height: view.height, deviceScaleFactor: 1, mobile: view.mobile });
            await Page.navigate({ url: process.env.CORAL_TEST_URL + '/' }); await Page.loadEventFired(); await install();
        };
        const list = view => view.mobile ? '#mobile-agent-list' : '.sidebar';
        const rows = view => ev(`(() => {
            const root = document.querySelector(${JSON.stringify(list(view))});
            const out = {};
            for (const li of root.querySelectorAll('.board-card-agents li.session-group-item')) {
                const name = (li.dataset.name || li.querySelector('.session-label')?.textContent || '').trim();
                out[name] = { h: Math.round(li.getBoundingClientRect().height), lines: ['.session-model', '.session-worktree-line', '.session-goal', '.session-activity-text'].filter(q => li.querySelector(q) && li.querySelector(q).getClientRects().length), chips: [...li.querySelectorAll('.session-state-pill')].map(c => c.textContent.trim()) };
            }
            const switches = ['branches', 'provider', 'thinking'].filter(k => document.querySelector(${JSON.stringify(list(view))} + ' [data-display-input="' + k + '"]'));
            return { rows: out, switches, hint: !!root.querySelector('[data-display-hint]:not([hidden])'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        })()`);
        const tip = name => ev(`String(window.buildSessionTooltip(T.state.liveSessions.find(s => s.name === ${JSON.stringify(name)}))).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ')`);
        const openPanel = view => ev(`(() => { const b = document.querySelector(${JSON.stringify(list(view) + ' [data-display-button]')}); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`);

        for (const view of [
            { name: 'sidebar', width: 1280, height: 900, mobile: false },
            { name: 'phone 390', width: 390, height: 844, mobile: true },
        ]) {
            console.log(`${view.name}: a team group of four one-line rows`);
            await load(view);
            assert.equal(await scene(), 4);
            await waitFor(`document.querySelectorAll(${JSON.stringify(list(view) + ' .board-card-agents li.session-group-item')}).length === 4`, `${view.name}: the four team rows`, 4000);
            await openPanel(view);
            const s = await rows(view);
            const want = view.mobile ? 56 : 36; // the phone's row is the sidebar's row at 56 px, with its status line (#10691)
            for (const [name, r] of Object.entries(s.rows)) {
                assert.ok(Math.abs(r.h - want) <= 1, `${view.name}: ${name} is one ${want} px line: ${r.h}`);
                assert.deepEqual(r.lines, [], `${view.name}: ${name} draws no goal, model, branch or activity line: ${JSON.stringify(r.lines)}`);
                assert.ok(r.chips.length <= 1, `${view.name}: ${name} has at most one chip: ${JSON.stringify(r.chips)}`);
            }
            assert.deepEqual(Object.keys(s.rows).length, 4);
            assert.deepEqual(s.switches, [], `${view.name}: the Display panel has no switch for the removed lines (Show summary and Show model came back, #10816, off by default: agent_list_show_lines_browser): ${JSON.stringify(s.switches)}`);
            assert.equal(s.hint, false, `${view.name}: and no hint about agents with no model or branch`);
            assert.equal(s.overflow <= 0, true, `${view.name}: no horizontal overflow: ${s.overflow}`);
            const [wt, shared, nogit, bare] = [await tip('wt-agent'), await tip('shared-agent'), await tip('nogit-agent'), await tip('bare-agent')];
            assert.match(wt, /fix\/login/, `${view.name}: the worktree agent's tip has its branch: ${wt}`);
            assert.match(shared, /main/, `${view.name}: the shared-checkout agent's tip has its branch too`);
            assert.doesNotMatch(nogit + bare, /fix\/login/);
            assert.match(nogit, /Opus/i, `${view.name}: an agent with a model shows it in its tip: ${nogit}`);
            assert.doesNotMatch(bare, /Opus|Sonnet/, `${view.name}: an agent with none shows none`);
            await shot(`team-rows-${view.name.replace(/\W+/g, '-')}`);
        }
        console.log('agent_list_team_rows: ok');
        await client.close();
        process.exit(0);
    } catch (e) {
        console.error('FAIL', e && e.stack || e);
        await client.close().catch(() => {});
        process.exit(1);
    }
})();
