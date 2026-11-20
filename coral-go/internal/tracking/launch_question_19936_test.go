package tracking

import "testing"

// #19936: a question the dashboard asked before anything started (the home folder, the first-launch notice) is recorded in launch_result with its own category and is NOT the funnel's failed launch.
func TestAQuestionIsNotTheFunnelsFailedLaunch(t *testing.T) {
	for _, cat := range []string{FailDisclosureAsked, FailHomeFolderAsked} {
		c, _ := newFunnelTracking(t)
		StartLaunch(KindAgent, "claude", "tmux", 1, false).Finish(OutcomeFailure, cat, 0, 1)
		waitForAsync()
		res := c.named(EventLaunchResult)
		if len(res) != 1 || res[0].Properties["failure_category"] != cat {
			t.Fatalf("%s: launch_result = %+v", cat, res)
		}
		if got := c.named(EventFunnelLaunchFailed); len(got) != 0 {
			t.Errorf("%s was sent as funnel_launch_failed: %+v", cat, got)
		}
	}
}

// A real refusal still is the funnel's failed launch, and every split-out category is a value the funnel accepts.
func TestEachRefusalCategoryIsAFunnelValue(t *testing.T) {
	cats := []string{FailWorkdirMissing, FailTeamAccessOff, FailNameTaken, FailInvalidModel, FailOutsideTeam, FailAgentTypeInvalid, FailInvalidRequest}
	for _, cat := range cats {
		c, _ := newFunnelTracking(t)
		StartLaunch(KindAgent, "claude", "tmux", 1, false).Finish(OutcomeFailure, cat, 0, 1)
		waitForAsync()
		got := c.named(EventFunnelLaunchFailed)
		if len(got) != 1 || got[0].Properties["failure_category"] != cat {
			t.Errorf("%s: funnel_launch_failed = %+v", cat, got)
		}
	}
}
