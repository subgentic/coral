//go:build !race

package background

// raceEnabled is true when the tests are built with the race detector (#14281).
const raceEnabled = false
