package main

import "testing"

// #17603: `coral-board heavy run` starts on every OS (Windows runs the command in a Job Object); nothing is refused here.
func TestHeavyRunIsNotRefusedOnAnyOS(t *testing.T) {
	if why := heavyUnsupportedHere(); why != "" {
		t.Fatalf("not refused: %q", why)
	}
}
