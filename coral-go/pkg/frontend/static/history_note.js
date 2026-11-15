/* The chat page says in words why there is no conversation to show (a job run whose agent never wrote anything, #17186, #17447), with Retry when it may still come. Lazy: the start path does not carry it. The page was already put in its
   read state (showHistoryReadState, which empties the window) when the read came back with no chat. */
export function showHistoryNote(text, retry = null) {
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

const NOT_YET = "This run's agent has not written anything yet, so there is no conversation to show. If it stays like this, the agent did not start: stop the run from the job's page and run the job again.";
const NEVER = "This run has no conversation: its agent never wrote anything, so it did not start. Run the job again from the job's page.";
/** A job run with no conversation: still going (status running or pending, or the row's state Starting) it may yet write, so Retry; otherwise it never started. */
export function noChat(status, retry) {
    const going = status === 'running' || status === 'pending' || status === 'Starting';
    showHistoryNote(going ? NOT_YET : NEVER, going ? retry : null);
}
