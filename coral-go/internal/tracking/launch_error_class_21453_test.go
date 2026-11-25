package tracking

import "testing"

// #21453: launch_result carries the error class of a failed launch, only for a failure, and only a value from the closed list.
func TestLaunchResultCarriesTheErrorClass(t *testing.T) {
	c, _ := newFunnelTracking(t)
	StartLaunch(KindAgent, "claude", "tmux", 1, false).ErrorClass(ClassLaunchFiles).Finish(OutcomeFailure, FailInternal, 0, 1)
	StartLaunch(KindAgent, "claude", "tmux", 1, false).ErrorClass(ClassLaunchFiles).Finish(OutcomeSuccess, "", 1, 0)
	StartLaunch(KindAgent, "claude", "tmux", 1, false).ErrorClass("/home/x/secret path").Finish(OutcomeFailure, FailInternal, 0, 1)
	waitForAsync()
	res := c.named(EventLaunchResult)
	if len(res) != 3 {
		t.Fatalf("launch_result events = %d", len(res))
	}
	withClass, failures := 0, 0
	for _, e := range res {
		v, has := e.Properties["error_class"]
		if e.Properties["outcome"] == OutcomeSuccess && has {
			t.Errorf("a success carries a class: %v", e.Properties)
		}
		if e.Properties["outcome"] == OutcomeFailure {
			failures++
		}
		if has {
			withClass++
			if v != ClassLaunchFiles {
				t.Errorf("class = %v", v)
			}
		}
	}
	// Two failures were sent, one with a class from the list and one with a value outside it: only the first carries a class.
	if failures != 2 || withClass != 1 {
		t.Errorf("failures %d, with a class %d (want 2 and 1)", failures, withClass)
	}
}
