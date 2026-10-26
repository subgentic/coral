//go:build race

package secrets

// The race detector makes every pass 5 to 20 times slower, so a time or a ratio read under it says nothing about the rules: the timing guards read no time under -race (they still run the pass
// over the text, so it is exercised and checked for what it returns). Normal runs, the go-tests job, keep the timing.
const raceEnabled = true
