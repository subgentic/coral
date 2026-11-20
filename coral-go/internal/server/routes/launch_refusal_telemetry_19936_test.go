package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/tracking"
)

// #19936: the first-launch notice (409 launch_disclosure_required) is a question, not a failed launch: launch_result says disclosure_asked and the funnel's failed-launch step is not sent.
func TestTheFirstLaunchNoticeIsNotCountedAsAFailedLaunch(t *testing.T) {
	sink := captureAnalytics(t)
	d := newDiscRig(t)
	code, out := d.launch(withKind(callerDashCookie), nil)
	require.Equal(t, http.StatusConflict, code, "%v", out)
	require.Equal(t, "launch_disclosure_required", out["code"])
	res := sink.wait(t, tracking.EventLaunchResult, 1)[0]
	assert.Equal(t, tracking.FailDisclosureAsked, res["failure_category"])
	tracking.WaitForAsyncForTest()
	sink.none(t, tracking.EventFunnelLaunchFailed)
}

// The refusals that were all invalid_request say which they are.
func TestLaunchRefusalsNameTheirOwnCategory(t *testing.T) {
	sink := captureAnalytics(t)
	d := newDiscRig(t)
	ack := func() { ackLaunchDisclosure(t, d.rig.ss) }
	ack()
	cases := []struct {
		name  string
		extra map[string]any
		want  string
	}{
		{"no working dir", map[string]any{"working_dir": ""}, tracking.FailWorkdirMissing},
		{"unknown agent type", map[string]any{"agent_type": "nonesuch"}, tracking.FailAgentTypeInvalid},
		{"invalid model", map[string]any{"model": "bad model!;"}, tracking.FailInvalidModel},
	}
	for i, c := range cases {
		code, out := d.launch(withKind(callerDashCookie), c.extra)
		require.Equal(t, http.StatusBadRequest, code, "%s: %v", c.name, out)
		res := sink.wait(t, tracking.EventLaunchResult, i+1)
		assert.Equal(t, c.want, res[i]["failure_category"], c.name)
	}
}
