// The node bounds of heap_growth_browser (#13622). Two counts: the LIVE nodes (deterministic: 4548 or 4574 in 25 runs on the mini, idle and under 8 busy loops) get a tight bound, the browser's own total
// (detached nodes the collector has not taken included) a loose one, because under load it rose in one step of 193 and stayed there with nothing leaking, and failed the first floor rule (+97 and +135 in the
// Hub Lead's pre-run, +128 and +193 on the mini). Every series below was measured, rounds 20 to 60 by 5, except the leak ones, which are the suite's own HEAP_LEAK_SELFTEST (3 nodes a round) on top of a measured one.
const assert = require('node:assert/strict');
const { nodeGrowth, nodeBound, totalFloorGrowth, totalFloorBound } = require('./helpers/heap_bounds');

const ROUNDS = [20, 25, 30, 35, 40, 45, 50, 55, 60];
const at = (live, nodes) => ROUNDS.map((n, i) => ({ n, live: live[i], nodes: nodes[i] }));
const per = 40;

// measured on the mini under 8 busy loops (nothing leaking)
const quietA = at([4574, 4548, 4574, 4548, 4548, 4574, 4548, 4574, 4574], [11468, 11420, 11432, 11287, 11287, 11480, 11287, 11468, 11468]);
const quietB = at([4548, 4548, 4574, 4574, 4548, 4548, 4574, 4548, 4548], [11420, 11432, 11480, 11356, 11287, 11422, 11335, 11287, 11295]);
// the run that failed the first floor rule: the total sits at 11287 at n=30, then holds 11480 for the last five samples (+193), the live count unchanged (the live column is that run's neighbour pattern)
const step = at([4548, 4574, 4548, 4548, 4574, 4574, 4574, 4548, 4574], [11468, 11420, 11287, 11287, 11480, 11480, 11482, 11480, 11480]);
// the Windows runner's total (nothing growing, 11293 to 11664): the live column is the same two states
const winB = at([4548, 4548, 4574, 4548, 4574, 4574, 4548, 4548, 4574], [11343, 11295, 11664, 11343, 11438, 11568, 11568, 11293, 11568]);

for (const [name, s] of [['quiet A', quietA], ['quiet B', quietB], ['the +193 step', step], ['Windows', winB]]) {
    assert.ok(nodeGrowth(s) <= nodeBound(per), `${name}: live grew ${nodeGrowth(s).toFixed(1)}, bound ${nodeBound(per)}`);
    assert.ok(totalFloorGrowth(s) <= totalFloorBound(per), `${name}: total floor grew ${totalFloorGrowth(s)}, bound ${totalFloorBound(per)}`);
}
// the step really was past the bound the first floor rule used for the total
assert.ok(totalFloorGrowth(step) > 50, 'the step is bigger than 50: it failed the first floor rule');

// the selftest leak, 3 nodes a round on the live count (and the same on the total), on top of the quiet series: caught on the live count, at the worst toggle by 9
const leak = s => s.map(x => ({ ...x, live: x.live + 3 * (x.n - 20), nodes: x.nodes + 3 * (x.n - 20) }));
for (const [name, s] of [['quiet A', quietA], ['quiet B', quietB], ['the step', step]]) {
    assert.ok(nodeGrowth(leak(s)) > nodeBound(per), `leak on ${name}: live grew ${nodeGrowth(leak(s))}, bound ${nodeBound(per)}`);
}
// a leak of detached nodes (not in the page, so only the total sees it) of 30 a round is caught (the total is loose: a slower detached leak is for the heap bound) by the total's bound
const detached = quietB.map(x => ({ ...x, nodes: x.nodes + 30 * (x.n - 20) }));
assert.ok(totalFloorGrowth(detached) > totalFloorBound(per), `detached leak: total floor grew ${totalFloorGrowth(detached)}, bound ${totalFloorBound(per)}`);
// fewer than eight samples (a short run): the first three and the last five may overlap, and the rule still answers
assert.equal(nodeGrowth([{ n: 10, live: 100 }, { n: 20, live: 90 }, { n: 30, live: 110 }]), 0);
console.log('ok: heap_growth node bounds (measured quiet series, the +193 step and the Windows series pass; a 3-node-a-round live leak and a 30-a-round detached one fail)');
