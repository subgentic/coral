/* The chat page says in words why there is no conversation to show (a job run whose agent never wrote anything, #17186, #17447), with Retry when it may still come. Lazy: the start path does not carry it. The page was already put in its
   read state (showHistoryReadState, which empties the window) when the read came back with no chat. */
function showHistoryNote(text, retry = null) {
    const c = document.getElementById('history-messages');
    if (!c) return;
    const line = document.createElement('div');
    line.className = 'empty-state empty-state-tight history-note';
    line.textContent = text;
    if (retry) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn btn-small';
        button.textContent = 'Retry'; button.addEventListener('click', retry);
        line.append(' ', button);
    }
    c.replaceChildren(line);
}

/** A job run with no conversation: its agent has not written a line yet, or never started. Retry looks again. */
export function noChat(retry) {
    showHistoryNote("This run has no conversation: its agent has not written anything. If it is still starting, try Retry in a moment; if it stays like this, the agent did not start, so run the job again from the job's page.", retry);
}
