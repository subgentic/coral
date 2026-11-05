// Count only the rows a suite itself made (#13389). The runner's shard server is shared: suites before this one leave rows behind and a
// suite running beside it can add one between two reads, so 'the total grew by one' is a guess (inbox_ignored_real read 'All 9', #13659).
// A suite names its rows (its board, its agent, the ids it uploaded) and asserts on those; a total is read only as a before/after pair of
// OWN rows. `rows` is any list the server returns; `own` is a predicate or { key: value } to match.
function ownRows(rows, own) {
    const test = typeof own === 'function' ? own : r => Object.entries(own).every(([k, v]) => r && r[k] === v);
    return (Array.isArray(rows) ? rows : []).filter(test);
}
// Poll `read()` (it returns the suite's OWN rows or their count) until it equals `want` or the tries run out; returns the last value.
async function settleOwn(read, want, { tries = 40, ms = 250 } = {}) {
    const size = v => (Array.isArray(v) ? v.length : v);
    let v = await read();
    for (let i = 1; i < tries && size(v) !== want; i++) { await new Promise(r => setTimeout(r, ms)); v = await read(); } // sleep-ok: the server catches up
    return v;
}
module.exports = { ownRows, settleOwn };
