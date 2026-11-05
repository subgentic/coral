// The DOM node bounds of heap_growth_browser (#13622); heap_growth_bounds.test.js pins them with series measured on the mini.
// Two counts, because they behave differently. LIVE nodes (the elements in the page, shadow roots included) have two states, 4548 and 4574 (26 apart: one block in the layout comes and goes), in every one
// of 25 runs, idle and under 8 busy loops. The browser's own `Nodes` metric also counts nodes that are no longer in the page and not yet collected: it sat at 11287 and rose in one step to 11480 (+193) in a
// loaded run and stayed there, which failed the floor rule (bound 50) with nothing leaking (+97 and +135 in the Hub Lead's pre-run, +128 and +193 on the mini).
// Live growth is the MEAN of the last five samples minus the MEAN of the first three: the two states average out (no leak: 26 at the very worst), and a leak of 3 nodes a round puts the windows 75 apart
// (49 at the worst toggle). The bound is a node a round (`per`, 40 for the suite's 40 rounds): above the worst no-leak 26, below the worst leak 49. The total gets the floor rule and a loose bound.
const mean = (xs, key) => xs.reduce((a, x) => a + x[key], 0) / xs.length;
const lowest = (xs, key) => Math.min(...xs.map(x => x[key]));
const nodeGrowth = series => Math.max(0, mean(series.slice(-5), 'live') - mean(series.slice(0, 3), 'live'));
const totalFloorGrowth = series => Math.max(0, lowest(series.slice(-5), 'nodes') - lowest(series.slice(0, 3), 'nodes'));
/** The most the live count may grow over `per` rounds after the warm-up: a node a round. */
const nodeBound = per => per;
/** The browser's total: 300 clears the 193-node step measured under load; a leak of detached nodes must be more than that over the run. */
const totalFloorBound = per => 300 + per / 4;
module.exports = { nodeGrowth, nodeBound, totalFloorGrowth, totalFloorBound };
