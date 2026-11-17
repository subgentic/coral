/** The task page opens (the row's open) and loads its Artifacts section after it: wait for the section's heading, then bring it to the top and focus its first file. Gives up after 8 s (a task with nothing readable has no section). */
export function scrollToTaskArtifacts(id) {
    const find = () => document.getElementById(`team-task-artifacts-head-${Number(id)}`);
    const go = (head) => { head.scrollIntoView({ block: 'start' }); const first = head.parentElement && head.parentElement.querySelector('.artifact-table button.dt-primary'); if (first) first.focus({ preventScroll: true }); }; // the first file takes the focus: no ring round a plain heading (#7404)
    const now = find();
    if (now) { go(now); return; }
    const watch = new MutationObserver(() => { const head = find(); if (head) { watch.disconnect(); clearTimeout(stop); go(head); } });
    const stop = setTimeout(() => watch.disconnect(), 8000);
    watch.observe(document.body, { childList: true, subtree: true });
}

