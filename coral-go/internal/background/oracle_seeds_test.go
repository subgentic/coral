package background

// oracleSeeds is how many seeds an oracle test runs: all of them in a plain run, a few under the race detector (#14281). The race detector needs concurrency, not coverage: a seed costs several times more
// under it, and on a CI runner of two cores the oracle seeds alone ran the go-race job to its limit. Each seed is still compared in full; only the count is cut, and the tests' coverage floors (how often each kind of
// case was reached) are for the plain run, which keeps every seed.
func oracleSeeds(full int) int {
	if raceEnabled {
		return min(full, 4)
	}
	return full
}
