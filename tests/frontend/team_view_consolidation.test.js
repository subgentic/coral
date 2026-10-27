const assert = require('node:assert/strict');
const CDP = require('chrome-remote-interface');
const BASE = require('./test_base').BASE;

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9222) });
  const { Page, Runtime, Emulation } = client;
  const ev = async expression => {
    const r = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const guard = await require('./helpers/settings_guard').guardSettings(); // the settings this suite changes are put back in its finally (#4849)
  try {
    await Page.enable();
    await Page.navigate({ url: BASE });
    await Page.loadEventFired();

    console.log('Testing consolidated Team view and Team settings...');

    // 1. Verify kebab menu contains "Team view" and "Team settings", and NOT "Agent availability" or "Team details"
    const kebabHtml = await ev(`(() => {
      // Mock live sessions so renderLiveSessions can build kebab menus
      window.state = window.state || {};
      window.state.liveSessions = [
        {
          name: 'worker-1',
          board_project: 'test-team',
          agent_type: 'codex',
          working_directory: '/Users/test/workspace',
          branch: 'feature/consolidation',
          display_name: 'Worker 1',
          role: 'Developer'
        }
      ];
      // Import render module
      return import((window.__coralStatic||'/static/')+'render.js').then(m => {
        document.body.classList.remove('popout-mode');
        localStorage.setItem('coral-group-by-team', 'true');
        document.getElementById('live-sessions-list')?.remove();
        const container = document.createElement('ul');
        container.id = 'live-sessions-list';
        document.body.appendChild(container);
        m.renderLiveSessions(window.state.liveSessions);
        const menu = document.querySelector('#live-sessions-list .sidebar-kebab-menu');
        return menu ? menu.innerHTML : '';
      });
    })()`);

    assert.ok(kebabHtml.includes('Team view'), 'Kebab menu should contain "Team view"');
    assert.ok(kebabHtml.includes('Team settings'), 'Kebab menu should contain "Team settings"');
    assert.ok(!kebabHtml.includes('Agent availability'), 'Kebab menu should NOT contain "Agent availability"');
    assert.ok(!kebabHtml.includes('Team details'), 'Kebab menu should NOT contain "Team details"');
    console.log('✓ Kebab menu labels verified (Team view, Team settings)');

    await ev(`(async () => {
      const { state } = await import((window.__coralStatic||'/static/')+'state.js');
      state.liveSessions = [
        {
          name: 'worker-1',
          board_project: 'test-team',
          agent_type: 'codex',
          working_directory: '/Users/test/workspace',
          branch: 'feature/consolidation',
          display_name: 'Worker 1',
          role: 'Developer'
        }
      ];
      const availModule = await import((window.__coralStatic||'/static/')+'team_availability.js');
      window.originalFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/api/sessions/live')) {
          return { ok: true, json: async () => [{ name: 'worker-1', board_project: 'test-team', working_directory: '/Users/test/workspace', branch: 'feature/consolidation', display_name: 'Worker 1', agent_type: 'codex', role: 'Developer' }] };
        }
        if (typeof url === 'string' && url.includes('/status')) {
          return {
            ok: true,
            json: async () => ({
              summary: { available: 1, busy: 1 },
              observed_at: new Date().toISOString(),
              agents: [
                {
                  name: 'Worker 1',
                  subscriber_id: 'Worker 1',
                  agent_type: 'codex',
                  role: 'Developer',
                  availability: 'available',
                  available: true,
                  reason: 'Idle and ready',
                  tasks: [],
                  reminder: true,
                  reminder_interval_seconds: 300
                },
                {
                  name: 'Worker 2',
                  subscriber_id: 'Worker 2',
                  agent_type: 'codex',
                  role: 'Tester',
                  availability: 'busy',
                  available: false,
                  reason: 'Testing changes',
                  tasks: [{ scope: 'board', id: 101, status: 'in_progress', title: 'Verify UI' }],
                  reminder: false
                }
              ],
              unassigned_tasks: [
                { scope: 'board', id: 102, status: 'pending', title: 'Doc update' }
              ],
              health_report: ['No issues detected.']
            })
          };
        }
        return window.originalFetch(url, opts);
      };
      availModule.showTeamAvailability('test-team');
    })()`);

    await ev(`new Promise(r => setTimeout(r, 100))`);

    const dialogText = await ev(`document.querySelector('#team-availability-dialog').textContent`);
    assert.ok(dialogText.includes('Team view'), 'Dialog title should be Team view');
    assert.ok(dialogText.includes('Directory'), 'Dialog should contain Directory metadata');
    assert.ok(dialogText.includes('Branch'), 'Dialog should contain Branch metadata');
    assert.ok(dialogText.includes('Agents'), 'Dialog should contain Agents count');
    assert.ok(dialogText.includes('Worker 1'), 'Dialog should display agent Worker 1');
    assert.ok(dialogText.includes('Worker 2'), 'Dialog should display agent Worker 2');
    assert.ok(dialogText.includes('Verify UI'), 'Dialog should display assigned task');
    assert.ok(dialogText.includes('Unassigned work'), 'Dialog should display unassigned work section');
    console.log('✓ Team view content and metadata display verified');

    // 3. Verify compact agent row layout
    const agentGridStyle = await ev(`(() => {
      const agent = document.querySelector('.availability-agent');
      const style = window.getComputedStyle(agent);
      return { display: style.display, gridTemplateColumns: style.gridTemplateColumns };
    })()`);
    assert.equal(agentGridStyle.display, 'grid', 'Agent row should use grid layout');
    console.log('✓ Compact agent row grid layout verified');

    // 4. Verify mobile responsiveness at 390px
    await Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobileFits = await ev(`(() => {
      const d = document.querySelector('#team-availability-dialog');
      return d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().width <= innerWidth;
    })()`);
    assert.ok(mobileFits, 'Dialog must fit mobile screen without overflowing');
    console.log('✓ Mobile responsive layout verified (390px)');
    await Emulation.clearDeviceMetricsOverride();

    // Close Team view
    await ev(`document.querySelector('#team-availability-dialog [data-dialog-close]').click()`);
    await ev(`new Promise(r => setTimeout(r, 50))`);

    // The team's working mode starts from none, so the Save below always has something to save: a repeat on the same server (--stress) saw the last run's saved mode and answered "Nothing to save".
    await ev(`fetch('/api/board/test-team/working-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'none', dependency_guidance: false, custom_instructions: '' }) }).then(r => r.status)`);

    // 5. Open the team's Settings tab (showTeamWorkingMode into a page host) and verify its settings (the all-Coral health switch is in Settings now, #5128).
    await ev(`(async () => {
      const modeModule = await import((window.__coralStatic||'/static/')+'team_working_mode.js');
      modeModule.showTeamWorkingMode('test-team', { page: document.body.appendChild(Object.assign(document.createElement('div'), { id: 'qa-ts-host', style: 'position:fixed;inset:0;display:flex;z-index:50;background:var(--bg-primary)' })) });
    })()`);
    // Wait until the page has loaded what it compares a Save with, so the edits below are made after it, as a person's are.
    const until = expr => ev(`new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (${expr}) resolve(true); else if (Date.now() - t0 > 15000) reject(new Error('timed out: ' + ${JSON.stringify(expr)})); else setTimeout(tick, 50); }; tick(); })`);
    await until(`document.querySelector('#team-settings-workspace .sv[data-ready]')`);

    assert.equal(await ev(`document.getElementById('team-settings-workspace').getAttribute('aria-label')`), 'Team settings', 'the page is named "Team settings"');

    const hasHealthMonitorCheckbox = await ev(`Boolean(document.querySelector('#team-settings-workspace input[name="board_health_monitor"]'))`);
    assert.ok(!hasHealthMonitorCheckbox, 'Team settings no longer carry the all-Coral board_health_monitor switch (it is in Settings, #5128)');

    // Change settings and save with the page's Save
    await ev(`(() => {
      const set = (name, v) => { const e = document.querySelector('#team-settings-workspace [name=' + name + ']'); if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
      set('mode', 'shared_checkout'); set('dependency_guidance', true); set('custom_instructions', 'Custom instructions for test.');
      document.querySelector('#team-settings-workspace .sv-save').click();
    })()`);
    await until(`/Saved|Could not/.test(document.querySelector('#team-settings-workspace .sv-status').textContent)`);
    const saveStatus = await ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`);
    assert.ok(saveStatus.includes('Saved'), 'Settings status should indicate Saved');
    console.log('✓ Team settings saved successfully');

    // The groups: Workflow, Messaging and Prompts (the Health check when the board serves it): no Global settings
    const groups = await ev(`Array.from(document.querySelectorAll('#team-settings-workspace .settings-tab .settings-tab-name')).map(t => t.textContent)`);
    assert.ok(groups.includes('Workflow') && groups.includes('Messaging') && groups.includes('Prompts') && !groups.includes('Global'), 'the page has team groups only: no Global settings: ' + groups.join(', '));
    const headings = await ev(`Array.from(document.querySelectorAll('#team-settings-health .sv-heading')).map(l => l.textContent)`);
    assert.deepEqual(headings, ['Reviews', 'Automatic rules', 'Work done off the books', 'Landing', 'Goals and open tasks', 'Release', 'Questions'], 'the Health check has its seven sections (Work done off the books: #7793; Landing, Goals and open tasks and Release: Goal #80; Questions: the reminder of an unanswered question, #7794)');
    console.log('\u2713 Groups verified (no Global settings)');

    // A failed working-mode save says so
    await ev(`(async () => {
      const origFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('/working-mode') && opts && opts.method === 'PUT') {
          return { ok: false, status: 500, json: async () => ({ error: 'Simulated settings disk error' }) };
        }
        return origFetch(url, opts);
      };
      const e = document.querySelector('#team-settings-workspace [name=custom_instructions]');
      e.value += ' Again.'; e.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      document.querySelector('#team-settings-workspace .sv-save').click();
      await new Promise(r => { const t = () => /Could not/.test(document.querySelector('#team-settings-workspace .sv-status').textContent) ? r(true) : setTimeout(t, 50); t(); }); // the failure line
      window.fetch = origFetch;
    })()`);

    const partialStatus = await ev(`document.querySelector('#team-settings-workspace .sv-status').textContent`);
    assert.ok(partialStatus.includes('Could not save') && partialStatus.includes('Simulated settings disk error'), 'Should say the save failed, and why: ' + partialStatus);
    assert.ok((await ev(`document.querySelector('#team-settings-workspace [name=custom_instructions]').value`)).endsWith(' Again.'), 'and what was typed stays');
    console.log('✓ Failed-save feedback verified');

    // Verify persisted settings via API
    const persistedWorkingMode = await ev(`fetch('/api/board/test-team/working-mode').then(r => r.json())`);
    assert.equal(persistedWorkingMode.mode, 'shared_checkout');
    assert.equal(persistedWorkingMode.dependency_guidance, true);
    assert.equal(persistedWorkingMode.custom_instructions, 'Custom instructions for test.', 'the failed save did not change the working mode');

    console.log('✓ Verified settings persistence (working mode)');

    // Leave the page
    await ev(`document.getElementById('qa-ts-host').remove()`);
    await ev(`new Promise(r => setTimeout(r, 50))`);

    console.log('ALL CONSOLIDATION CHECKS PASSED!');
  } finally {
    await guard.restore().catch(e => console.error('settings restore: ' + (e && e.message)));
    await client.close();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
