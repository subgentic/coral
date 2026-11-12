//go:build race

package routes

import "time"

// underRace stretches a latency bound for a build with the race detector, which runs several times slower; the bound still catches a route that blocks for seconds (#15748).
func underRace(d time.Duration) time.Duration { return 5 * d }
