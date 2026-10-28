// The Operator's Analytics design (#9236): one sidebar entry per metric (Overview, Tokens per commit, Task time, Tool and API calls); the seven groupings are a Group by selector inside Overview (All is Overview
// itself), an old /analytics/<grouping> page opens Overview with that grouping chosen, and Tokens per commit starts grouped by Model with an empty line that says to pick a longer range. jsdom.
import assert from 'node:assert/strict';
import { installDom, importUi } from './helpers/jsdom_env.mjs';
const dom = installDom({ mode: 'local' });
try {
    const doc = document;
    doc.body.innerHTML = `<input id="cost-search"><ul id="cost-nav-list"></ul><div id="cost-dashboard-view"><h2 id="cost-view-title"></h2><select id="cost-time-range"><option value="day">Last 24 hours</option><option value="week">Last 7 days</option></select><span id="cost-range-text"></span>
      <div class="cost-summary-cards" data-cview="overview">cards</div>
      <section id="cost-spend-section" data-cview="per-commit"><h3 class="cost-section-title">Tokens per commit</h3><div id="cost-spend">old commit view</div></section>
      <section id="cost-task-time-section" data-cview="task-time"><h3 class="cost-section-title">Task time</h3><div id="cost-task-time">old</div></section>
      <div data-cview="provider">by provider</div><div data-cview="model">by model</div><div data-cview="agent">by agent</div><div data-cview="agent-detail">one agent</div><div data-cview="calls">calls</div></div>`;
    globalThis.fetch = window.fetch = async () => Response.json({ metric: 'tokens_per_commit', group_by: 'model', range: '24h', min_sample: 10, total: { n: 0 }, average: {}, groups: [] });
    const V = await importUi('analytics_views');
    const listed = () => [...doc.querySelectorAll('#cost-nav-list .row-btn')].map(b => b.textContent);
    const active = () => (doc.querySelector('#cost-nav-list li.active .row-btn') || {}).textContent;
    const bar = () => doc.getElementById('cost-group-bar');
    const pressed = () => (bar().querySelector('.eff-seg-btn[aria-pressed="true"]') || {}).textContent;
    const visible = () => [...doc.querySelectorAll('#cost-dashboard-view [data-cview]')].filter(e => !e.hidden).map(e => e.dataset.cview);

    V.selectView('overview', { fromHistory: true });
    assert.deepEqual(listed(), ['Overview', 'Tokens per commit', 'Task time', 'Advanced'], 'one entry per metric: no By provider, By model, By thinking level, By team, By agent, By branch or By task; Tool and API calls is under Advanced (#10521)');
    assert.equal(active(), 'Overview');
    assert.deepEqual([...bar().querySelectorAll('.eff-seg-btn')].map(b => b.textContent), ['All', 'Provider', 'Model', 'Thinking level', 'Team', 'Agent', 'Branch', 'Task'], 'Overview has the Group by selector');
    assert.equal(pressed(), 'All'); assert.deepEqual(visible(), ['overview']);
    assert.equal(doc.getElementById('cost-view-title').textContent, 'Overview');

    // a grouping: Overview with that grouping chosen
    [...bar().querySelectorAll('.eff-seg-btn')].find(b => b.textContent === 'Provider').click();
    assert.deepEqual(visible(), ['provider'], 'the Provider choice shows the provider page'); assert.equal(pressed(), 'Provider');
    assert.equal(active(), 'Overview', 'the sidebar still says Overview'); assert.equal(doc.getElementById('cost-view-title').textContent, 'Overview', 'and so does the title');
    const pick = bar().querySelector('.eff-pick'); pick.value = 'agent'; pick.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.deepEqual(visible(), ['agent'], 'the phone select chooses too'); assert.equal(pressed(), 'Agent');
    [...bar().querySelectorAll('.eff-seg-btn')].find(b => b.textContent === 'All').click();
    assert.deepEqual(visible(), ['overview'], 'All is Overview itself');

    // an old link: /analytics/model opens Overview grouped by Model
    V.selectView('model', { fromHistory: true });
    assert.equal(pressed(), 'Model'); assert.equal(active(), 'Overview'); assert.equal(doc.getElementById('cost-view-title').textContent, 'Overview');
    // one agent's page and the metric pages have no selector of their own here
    V.selectView('agent-detail', { fromHistory: true }); assert.equal(bar().hidden, true, 'one agent has its Back, not the selector'); assert.equal(active(), 'Overview');
    V.selectView('calls', { fromHistory: true }); assert.equal(bar().hidden, true); assert.equal(active(), 'Tool and API calls');
    V.selectView('per-commit', { fromHistory: true }); assert.equal(bar().hidden, true, 'a metric page has its own Group by (analytics_efficiency.js)'); assert.equal(active(), 'Tokens per commit');

    // Tokens per commit starts at Model, and an empty range says what to do
    const eff = await importUi('analytics_efficiency');
    eff.syncEfficiency('day');
    await new Promise(r => setTimeout(r, 40));
    const seg = doc.getElementById('cost-spend-section').querySelector('.eff-seg-btn[aria-pressed="true"]');
    assert.equal(seg.textContent, 'Model', 'Tokens per commit starts grouped by Model');
    assert.equal(doc.getElementById('cost-spend').hidden, true, 'so the comparison is the first sight, not the team view');
    assert.match(doc.getElementById('cost-eff-per-commit').textContent, /^No commits in the last 24 hours: pick a longer range above\.$/, 'the empty line says what to do');
    eff.syncEfficiency('month'); await new Promise(r => setTimeout(r, 40));
    assert.match(doc.getElementById('cost-eff-per-commit').textContent, /^No commits in the last 30 days: nothing to compare yet\.$/, 'and at the longest range there is no longer one to pick');
    console.log('analytics_overview_group: ok');
} finally { dom.close && dom.close(); }
