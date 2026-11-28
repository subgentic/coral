// The Inbox's Tasks tab is out for now (#22109). A dev build started with CORAL_TEST_HOOKS=1 (the runner's) shows it again when
// localStorage says coral-test-tasks-tab=1, so the suites that drive the kept Tasks page still can. Call before the first navigation:
// the key is written before any page script on every load (the runner clears the origin's storage between suites).
async function showTasksTab(Page) {
    await Page.addScriptToEvaluateOnNewDocument({ source: `try { localStorage.setItem('coral-test-tasks-tab', '1'); } catch (_) {}` });
}
module.exports = { showTasksTab };
