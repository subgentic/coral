// A suite that dies with "WebSocket connection closed" (#15933) says nothing about WHY: the shard's Chrome exited, or one tab went (a renderer crash, a tab closed under it),
// or the page was closed by the suite itself. The runner appends this note to such a failure: whether Chrome is still running (its exit code or signal), the pages it has open, and the tail of its stderr.
export const WS_CLOSED = /WebSocket connection closed/;

// probe() answers { exit: 'exit code 1 signal null' | null, pages: ['url', ...] | null, stderr: '...' }; one that throws is said, never allowed to hide the suite's own failure.
export async function wsCloseNote(out, shardN, probe) {
    if (!WS_CLOSED.test(out || '')) return '';
    let p;
    try { p = await probe(); } catch (e) { return `\n  [runner] shard ${shardN}: the suite's CDP socket closed; looking at Chrome failed: ${String(e.message || e).split('\n')[0]}`; }
    const pages = p.pages == null ? 'its page list could not be read' : `${p.pages.length} page(s) open${p.pages.length ? ': ' + p.pages.map(u => u.split('?')[0].slice(0, 60)).join(', ') : ''}`;
    const stderr = (p.stderr || '').split('\n').filter(l => l.trim() && !/cv_display_link_mac|Trying to load the allocator/.test(l)).slice(-8).join('\n    '); // a headless Mac Chrome prints those two all the time
    return `\n  [runner] shard ${shardN}: the suite's CDP socket closed. Chrome ${p.exit ? 'HAS EXITED (' + p.exit + ')' : 'is still running'}; ${pages}.` + (stderr ? `\n  Chrome stderr (last lines):\n    ${stderr}` : '');
}
