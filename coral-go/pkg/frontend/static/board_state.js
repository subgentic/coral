/* What the board page and its parts share: the open board, the loaded window of its messages, the pause flag and the counts the poll and the pill keep (moved out of message_board.js, #8399; no behaviour change). */
export const bs = {
    currentProject: null,
    isPaused: false,
    _allMessages: [],
    _totalMessages: 0,
    _loadedOffset: 0, // older messages not loaded yet (the offset of the first loaded one)
    _loadedProject: null, // board whose initial page is loaded; polls wait for it
    _countedTotal: 0, // the board's total as the rows loaded account for it (see _pollNewMessages)
    _staleRows: false, // a message shown may have been deleted: the latest page is loaded again at the bottom
    pendingMessageId: null,
    _replyTo: null, // { id, name }: the message the composer's text answers (Reply), sent with the post while the text still starts with the name
    _unseen: 0,
};
