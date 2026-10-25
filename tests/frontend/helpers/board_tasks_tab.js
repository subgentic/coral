// The board's tasks are the Tasks tab of an agent on that board: the board's page has no side panel (#7457). Opens that tab for `board` on a page the harness has loaded: an agent is added to the live list on the
// board (board_project), selected, and the side panel is opened (a phone's overlay too) on its Tasks tab.
async function openBoardTasksTab({ ev, waitFor }, board, name = 'bt-agent') {
    await ev(`window.__m.add(${JSON.stringify(name)}, 'B', 1, { sleeping: false, board_project: ${JSON.stringify(board)} }); true`);
    await waitFor(`(window.__qaState.liveSessions || []).some(s => s.name === ${JSON.stringify(name)})`, 'the agent on the board', 8000);
    await ev(`window.selectLiveSession(${JSON.stringify(name)}, 'claude', ${JSON.stringify(name + '-id')}, 'local'); true`);
    await ev(`(() => { const d = document.getElementById('agentic-state'); if (d.getBoundingClientRect().width < 50 || d.classList.contains('collapsed')) { const b = document.getElementById('panel-toggle-btn') || document.getElementById('popout-panel-toggle-btn'); if (b) b.click(); } const t = document.getElementById('agentic-tab-tasks'); if (t) t.click(); return true; })()`);
}
module.exports = { openBoardTasksTab };
