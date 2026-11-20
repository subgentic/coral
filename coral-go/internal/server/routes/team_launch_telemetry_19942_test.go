package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/tracking"
)

// #19942: a team launch's own refusals say which they are, like a single agent's (#19936).
func TestCheckTeamRequestNamesTheCategory(t *testing.T) {
	ok := launchTeamRequest{BoardName: "b", WorkingDir: "/tmp", Agents: []launchTeamAgent{{Name: "A"}}}
	msg, cat := checkTeamRequestFor(ok)
	assert.Empty(t, msg)
	assert.Empty(t, cat)
	for name, c := range map[string]struct {
		mod  func(r *launchTeamRequest)
		want string
	}{
		"no folder":          {func(r *launchTeamRequest) { r.WorkingDir = "" }, tracking.FailWorkdirMissing},
		"no board":           {func(r *launchTeamRequest) { r.BoardName = "" }, tracking.FailInvalidRequest},
		"no members":         {func(r *launchTeamRequest) { r.Agents = nil }, tracking.FailInvalidRequest},
		"a bad team type":    {func(r *launchTeamRequest) { r.AgentType = "nope" }, tracking.FailAgentTypeInvalid},
		"a bad member type":  {func(r *launchTeamRequest) { r.Agents = []launchTeamAgent{{Name: "A", AgentType: "nope"}} }, tracking.FailAgentTypeInvalid},
		"a bad member model": {func(r *launchTeamRequest) { r.Agents = []launchTeamAgent{{Name: "A", Model: "-rf"}} }, tracking.FailInvalidModel},
		"a bad thinking":     {func(r *launchTeamRequest) { r.Agents = []launchTeamAgent{{Name: "A", Thinking: "bogus!"}} }, tracking.FailInvalidModel},
	} {
		r := ok
		c.mod(&r)
		m, cat := checkTeamRequestFor(r)
		assert.NotEmpty(t, m, name)
		assert.Equal(t, c.want, cat, name)
	}
}

// A team whose only members have no name starts nobody: failure, with its own category.
func TestATeamOfUnnamedMembersIsMemberUnnamed(t *testing.T) {
	sink := captureAnalytics(t)
	d := newDiscRig(t)
	ackLaunchDisclosure(t, d.rig.ss)
	_, _ = d.team(withKind(callerDashCookie), map[string]any{"name": ""})
	res := sink.wait(t, tracking.EventLaunchResult, 1)[0]
	assert.Equal(t, "failure", res["outcome"])
	assert.Equal(t, tracking.FailMemberUnnamed, res["failure_category"])
}

// A team's first-launch notice is a question: nothing starts and no failed launch reaches the funnel.
func TestATeamsFirstLaunchNoticeSendsNoFunnelLaunchFailed(t *testing.T) {
	sink := captureAnalytics(t)
	d := newDiscRig(t)
	code, out := d.team(withKind(callerDashCookie), map[string]any{"name": "A"})
	require.Equal(t, http.StatusConflict, code, "%v", out)
	require.Equal(t, "launch_disclosure_required", out["code"])
	tracking.WaitForAsyncForTest()
	sink.none(t, tracking.EventFunnelLaunchFailed)
	for _, e := range sink.named(tracking.EventLaunchResult) {
		assert.NotEqual(t, "invalid_request", e["failure_category"])
	}
}
