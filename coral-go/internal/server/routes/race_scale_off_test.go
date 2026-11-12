//go:build !race

package routes

import "time"

func underRace(d time.Duration) time.Duration { return d }
