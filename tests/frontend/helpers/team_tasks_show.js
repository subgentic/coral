// Team Tasks keeps four state pills (Open, In review, Blocked, Done); All, Queued, In progress and Needs review are in the Filters panel's "Show tasks that are" select (#15829).
// showState(ev, key) picks one of the eight through that select, opening the panel first when it is shut and putting it back as it was.
module.exports = { async showState(ev, key) {
    const was = await ev(`(() => { if (document.querySelector('#team-tasks-show')) return 'open'; document.querySelector('#team-panel-tasks .list-bar-toggle').click(); return 'shut'; })()`);
    for (let i = 0; i < 40 && !(await ev(`!!document.querySelector('#team-tasks-show')`)); i++) await new Promise(r => setTimeout(r, 100));
    const ok = await ev(`(() => { const s = document.querySelector('#team-tasks-show'); if (!s) return false; s.value = ${JSON.stringify(key)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value === ${JSON.stringify(key)}; })()`);
    if (was === 'shut') await ev(`document.querySelector('#team-panel-tasks .list-bar-toggle')?.click(); true`);
    await new Promise(r => setTimeout(r, 300));
    if (!ok) throw new Error(`the Show select has no state "${key}"`);
} };
