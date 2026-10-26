// The board's page is its team page's Messages tab (#8129): the board's own column (#mb-board: the search, the messages, the composer) sits in the team page. A suite that opens a board asks for it
// (selectBoardProject redirects to /team/<team>/messages) and waits for the column to be on the team page. `ev` and `waitFor` are the suite's page-side evaluate and wait.
async function openBoardPage(ev, waitFor, board, messageId = null) {
    await ev(`import((window.__coralStatic || '/static/') + 'message_board.js').then(mb => { mb.selectBoardProject(${JSON.stringify(board)}${messageId != null ? ', ' + JSON.stringify(messageId) : ''}); return true; })`);
    await waitFor(`!!document.querySelector('#team-page-view #mb-board') && getComputedStyle(document.getElementById('mb-board')).display !== 'none' && document.getElementById('team-page-view').getClientRects().length > 0`, `the board ${board} on the team page`, 15000);
}
module.exports = { openBoardPage };
