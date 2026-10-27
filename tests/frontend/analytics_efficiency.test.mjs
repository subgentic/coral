// Goal #77: Tokens per commit and Task time have a Group by switch; All is the section's own content, any other grouping is the comparison across teams (cards, bars with the average line, a table; groups under
// the minimum sample hatched, tagged "few" and never called the most efficient). Stubbed GET /api/analytics/efficiency, jsdom.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
try {
    const doc = document;
    doc.body.innerHTML = `<div id="cost-dashboard-view">
      <section id="cost-spend-section" data-cview="per-commit"><h3 class="cost-section-title">Tokens per commit</h3><div id="cost-spend">old commit view</div></section>
      <section id="cost-task-time-section" data-cview="task-time"><h3 class="cost-section-title">Task time</h3><div id="cost-task-time">old time view</div></section></div>`;
    const reads = [];
    const answer = (metric, group) => metric === 'tokens_per_commit'
        ? { metric, group_by: group, range: '7d', min_sample: 10, total: { n: 125 }, average: { value: 300000, usual: 310000 }, unmeasured: ['gemini', 'unknown'], groups: [
            { key: 'sonnet', label: 'claude-sonnet-5-5', provider: 'claude', value: 268000, n: 61, tokens: 16300000, cost_usd_per_unit: 2.2 },
            { key: 'opus', label: 'claude-opus-5-5', provider: 'claude', value: 412000, n: 38, tokens: 15700000, cost_usd_per_unit: 6.8 },
            { key: 'haiku', label: 'claude-haiku-5-5', provider: 'claude', value: 141000, n: 12, tokens: 1700000, cost_usd_per_unit: 0.6 },
            { key: 'pi', label: 'pi: qwen3-coder', provider: 'pi', value: 190000, n: 4, tokens: 800000, cost_usd_per_unit: 0.9, low_sample: true },
            { key: 'none', label: 'idle-model', provider: 'agy', n: 0 }] }
        : { metric, group_by: group, range: '7d', min_sample: 10, total: { n: 260 }, average: { value: 1080 }, unmeasured: ['unknown'], groups: [
            { key: 'low', label: 'Low', value: 540, n: 57, sent_back_share: 0.29, cost_usd_per_unit: 1.4 },
            { key: 'high', label: 'High', value: 1440, n: 64, sent_back_share: 0.12, cost_usd_per_unit: 5.3 },
            { key: 'max', label: 'Max', value: 2460, n: 5, sent_back_share: 0.1, cost_usd_per_unit: 9 }] };
    globalThis.fetch = window.fetch = async url => { const u = new URL(url, 'https://x.example'); reads.push(u.search); return Response.json(answer(u.searchParams.get('metric'), u.searchParams.get('group_by'))); };
    window.localStorage.setItem('coral-eff-group-commit', 'all'); window.localStorage.setItem('coral-eff-group-time', 'all'); // the flow below starts at All (the default is Model, analytics_overview_group.test.mjs)
    const eff = await importUi('analytics_efficiency');
    const settle = () => new Promise(r => setTimeout(r, 20));
    eff.syncEfficiency('week');
    const sec = id => doc.getElementById(id);
    assert.equal(sec('cost-spend-section').querySelectorAll('.eff-seg-btn').length, 8, 'Group by has All, Provider, Model, Thinking level, Team, Agent, Branch, Task');
    assert.deepEqual([...sec('cost-task-time-section').querySelectorAll('.eff-seg-btn')].map(b => b.textContent), ['All', 'Provider', 'Model', 'Thinking level', 'Team', 'Agent', 'Branch'], 'Task time has no Task grouping: every task is a group of one');
    assert.equal(sec('cost-spend').hidden, false, 'All shows the section\'s own content');
    assert.equal(sec('cost-eff-per-commit').hidden, true, 'and not the comparison');
    assert.equal(reads.length, 0, 'All reads nothing new');
    const click = (section, name) => [...sec(section).querySelectorAll('.eff-seg-btn')].find(b => b.textContent === name).click();
    click('cost-spend-section', 'Model'); await settle();
    assert.equal(sec('cost-spend').hidden, true, 'a grouping hides the old content');
    assert.match(reads[0], /metric=tokens_per_commit&group_by=model&range=7d/);
    const v = sec('cost-eff-per-commit'), text = v.textContent.replace(/\s+/g, ' ');
    assert.match(text, /Most efficient \(at least 10 commits\)claude-haiku-5-5/, 'the most efficient group with enough commits');
    assert.match(text, /141K per commit, 53% under the 300K average/, 'its figure against the average');
    assert.match(text, /Average, all commits300KUsual last week: 310K/);
    assert.match(text, /pi: qwen3-coder4 commits · too few to rank/, 'a group under 10 is said to be too few');
    assert.match(text, /gemini writes no usage rows, so its commits are left out\./);
    assert.match(text, /Provider not recorded: commits of no recorded session are left out\./, 'work of no recorded session is named, not hidden');
    assert.equal(v.querySelectorAll('.eff-fill.eff-few').length, 1, 'one hatched bar');
    assert.equal(v.querySelectorAll('.eff-bar').length, 4, 'a group with no commits has no bar');
    assert.match(v.querySelector('table').textContent, /idle-model.*no data/s, 'but it is in the table');
    assert.ok(!/most efficient/.test([...v.querySelectorAll('tr')].filter(r => /pi: qwen3/.test(r.textContent)).map(r => r.textContent).join('')), 'the few group is not called most efficient');
    assert.match(v.querySelector('table').textContent, /few/, 'the table tags it');
    assert.equal(sec('cost-spend-section').querySelector('.eff-seg-btn[aria-pressed="true"]').textContent, 'Model');
    // Task time: Thinking level, sent back and cost per task
    click('cost-task-time-section', 'Thinking level'); await settle();
    const t = sec('cost-eff-task-time').textContent.replace(/\s+/g, ' ');
    assert.match(reads.at(-1), /metric=task_time&group_by=thinking/);
    assert.match(t, /Provider not recorded: tasks of no recorded session are left out\./);
    assert.match(t, /Fastest \(at least 10 tasks\)Low/);
    assert.match(t, /Cheapest per taskLow\$1\.40 per task/);
    assert.match(t, /Max5 tasks · 10% sent back · too few to rank/);
    assert.match(t, /% under the [\d.]+ \w+ median/, 'the line and the cards say median, the answer\'s figure for task time');
    assert.match(t, /The line is the median across all tasks\./); assert.ok(!/average/.test(t), 'no "average" anywhere on Task time: ' + t.slice(0, 300));
    assert.ok([...sec('cost-eff-task-time').querySelectorAll('th')].some(h => h.textContent === 'vs median'), 'the table column is vs median');
    assert.match(text, /The line is the average across all commits\./, 'Tokens per commit keeps the average');
    // Tokens per commit by Task: a plain list of the tasks that had a commit, cheapest first; a cost under a cent is "<$0.01"
    globalThis.fetch = window.fetch = async () => Response.json({ metric: 'tokens_per_commit', group_by: 'task', range: '7d', min_sample: 10, total: { n: 3 }, average: { value: 5000 }, groups: [
        { key: '7', label: '#7 Slow', value: 9000, n: 1, tokens: 9000, cost_usd_per_unit: 0.004, low_sample: true }, { key: '8', label: '#8 Quick', value: 2000, n: 2, tokens: 4000, cost_usd_per_unit: 0, low_sample: true }, { key: '9', label: '#9 Idle', n: 0, tokens: 0, low_sample: true }] });
    click('cost-spend-section', 'Task'); await settle();
    const tl = sec('cost-eff-per-commit'), tlText = tl.textContent.replace(/\s+/g, ' ');
    assert.equal(tl.querySelectorAll('.eff-card, .eff-bar, .eff-tag').length, 0, 'no cards, bars or few tags: nothing to rank');
    assert.match(tlText, /1 task has no commit and is not listed\./);
    const trs = [...tl.querySelectorAll('tbody tr')].map(r => r.textContent.replace(/\s+/g, ' '));
    assert.equal(trs.length, 2, 'only tasks with a commit'); assert.match(trs[0], /#8 Quick/, 'fewest tokens per commit first'); assert.match(trs[1], /#7 Slow/);
    assert.match(trs[0], /\$0\.00/, 'a cost of zero reads $0.00, like every cost on the Analytics pages (#9540)'); assert.match(trs[1], /<\$0\.01/, 'under a cent');
    // back to All
    click('cost-spend-section', 'All'); await settle();
    assert.equal(sec('cost-spend').hidden, false); assert.equal(sec('cost-eff-per-commit').hidden, true);
    // every figure 0 (an average of 0): no NaN or Infinity anywhere, no bar of NaN width
    globalThis.fetch = window.fetch = async () => Response.json({ metric: 'task_time', group_by: 'team', range: '7d', min_sample: 10, total: { n: 22 }, average: { value: 0 }, groups: [{ key: 'a', label: 'alpha', value: 0, n: 12, sent_back_share: 0, cost_usd_per_unit: 0 }, { key: 'b', label: 'beta', value: 0, n: 10, sent_back_share: 0, cost_usd_per_unit: 0 }] });
    click('cost-task-time-section', 'Team'); await settle();
    const z = sec('cost-eff-task-time'), zt = z.textContent;
    assert.ok(!/NaN|Infinity|undefined/.test(zt), 'no NaN or Infinity in the cards or the table: ' + zt.slice(0, 200));
    assert.ok([...z.querySelectorAll('.eff-fill, .eff-avg')].every(e => /^\d/.test(e.style.width || e.style.left || '0') ), 'no bar or line of NaN width');
    assert.equal(z.querySelectorAll('.eff-bar').length, 2);
    assert.ok(/\$0\.00/.test(zt) && !/no cost/.test(zt), 'a cost of 0 reads $0.00, never "no cost" (#9540): ' + zt.slice(0, 300));
    // an error says so and Retry reads again
    globalThis.fetch = window.fetch = async () => new Response('{}', { status: 500 });
    click('cost-spend-section', 'Agent'); await settle();
    assert.match(sec('cost-eff-per-commit').textContent, /Could not load the comparison \(500\)\./);
    assert.ok(sec('cost-eff-per-commit').querySelector('button'), 'with a Retry');
    console.log('analytics_efficiency: ok');
} finally { dom.close && dom.close(); }
