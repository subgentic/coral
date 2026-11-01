package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11759 (Security's INFO on #11713): the Orchestrator is the one the team was launched with. A join that claims the role's name or title on a team that already has a holder of it, active or away, is refused; the
// holder itself may join again; and while the launched Orchestrator is there it is the team's Orchestrator even if another member holds the title.
func TestAJoinCannotTakeTheOrchestratorSeatWhileTheRealOneIsAway(t *testing.T) {
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/seat"
	ctx := context.Background()
	// the team was launched with an Orchestrator (the launch marks it can_peek), then that session went away
	_, err := h.bs.Subscribe(ctx, "seat", "Orchestrator", "Orchestrator", "claude-aaaa", nil, "all", true)
	require.NoError(t, err)
	_, err = h.bs.Unsubscribe(ctx, "seat", "Orchestrator")
	require.NoError(t, err)

	join := func(id, title string) int {
		resp := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": id, "job_title": title})
		defer resp.Body.Close()
		return resp.StatusCode
	}
	assert.Equal(t, http.StatusConflict, join("Dev", "Orchestrator"), "a worker that joins with the title while the real one is away is refused")
	assert.Equal(t, http.StatusConflict, join("Dev", "Lead orchestrator"), "and with the word anywhere in the title")
	assert.Equal(t, http.StatusConflict, join("Orchestrator 2", "Agent"), "or in its name")
	_, err = h.bs.TeamOrchestrator(ctx, "seat")
	assert.Error(t, err, "nobody else became the Orchestrator")

	assert.Equal(t, http.StatusOK, join("Dev", "Backend Dev"), "a worker with its own role joins as ever")
	assert.Equal(t, http.StatusOK, join("Orchestrator", "Orchestrator"), "the holder joins again (a restart)")
	got, err := h.bs.TeamOrchestrator(ctx, "seat")
	require.NoError(t, err)
	assert.Equal(t, "Orchestrator", got)
}

func TestATeamWithNoOrchestratorLetsTheFirstClaimStand(t *testing.T) {
	server, h := setupBoardTestServer(t)
	base := server.URL + "/api/board/noseat"
	resp := postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Lead", "job_title": "Orchestrator"})
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	got, err := h.bs.TeamOrchestrator(context.Background(), "noseat")
	require.NoError(t, err)
	assert.Equal(t, "Lead", got)
	resp = postJSON(t, base+"/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Orchestrator"})
	resp.Body.Close()
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "a second claim is refused")
}

func TestTheLaunchedOrchestratorIsChosenBeforeAMemberThatHoldsTheTitle(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	// an older team: a member joined with the title first, the launched one came later
	_, err := h.bs.Subscribe(ctx, "legacy", "Squatter", "Orchestrator", "claude-bbbb", nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "legacy", "Real Orchestrator", "Orchestrator", "claude-cccc", nil, "all", true)
	require.NoError(t, err)
	got, err := h.bs.TeamOrchestrator(ctx, "legacy")
	require.NoError(t, err)
	assert.Equal(t, "Real Orchestrator", got, "the launched one, not the earlier title-holder")
}

// #11759, QA's SHOULD 3: a re-join does not erase the launch record. The launched Orchestrator joins again through the join route (which never sets can_peek) after a member took the title; it is still the team's Orchestrator.
func TestAReJoinOfTheLaunchedOrchestratorKeepsItsLaunchRecord(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "rejoin", "Lead", "Backend Dev", "claude-1111", nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "rejoin", "Squatter", "Orchestrator", "claude-2222", nil, "mentions") // a legacy member that holds the title
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "rejoin", "Real", "Orchestrator", "claude-3333", nil, "all", true) // the launched one
	require.NoError(t, err)
	resp := postJSON(t, server.URL+"/api/board/rejoin/subscribe", map[string]string{"subscriber_id": "Real", "job_title": "Orchestrator"}) // it restarts and joins again: no can_peek in this route
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	sub, err := h.bs.GetProjectSubscription(ctx, "rejoin", "Real")
	require.NoError(t, err)
	assert.NotZero(t, sub.CanPeek, "the launch record is still there")
	got, err := h.bs.TeamOrchestrator(ctx, "rejoin")
	require.NoError(t, err)
	assert.Equal(t, "Real", got, "and the launched one is still chosen before the earlier title-holder")
}

// #11759, QA's SHOULD 4: a holder whose role is only in its NAME (its title says something else) still holds the seat.
func TestAHolderWhoseRoleIsOnlyInItsNameStillHoldsTheSeat(t *testing.T) {
	server, h := setupBoardTestServer(t)
	_, err := h.bs.Subscribe(context.Background(), "byname", "Orchestrator 2", "Agent", "claude-4444", nil, "all", true)
	require.NoError(t, err)
	resp := postJSON(t, server.URL+"/api/board/byname/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Orchestrator"})
	resp.Body.Close()
	assert.Equal(t, http.StatusConflict, resp.StatusCode, "a worker cannot take the seat from a holder that is only called Orchestrator in its name")
	resp = postJSON(t, server.URL+"/api/board/byname/subscribe", map[string]string{"subscriber_id": "Dev", "job_title": "Backend Dev"})
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode, "and a worker with its own role still joins")
}

// #11759, Security's INFO: can_peek also grants the Orchestrator's reads and completion review, so it must not linger. Only the join route keeps it; the launch and a restart set it as given, so a member launched as
// Orchestrator and relaunched under the same name in another role loses it.
func TestAMemberRelaunchedInAnotherRoleLosesTheLaunchRecord(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "relaunch", "Lead", "Orchestrator", "claude-5555", nil, "all", true) // launched as Orchestrator
	require.NoError(t, err)
	before, err := h.bs.GetProjectSubscription(ctx, "relaunch", "Lead")
	require.NoError(t, err)
	require.NotZero(t, before.CanPeek)
	_, err = h.bs.Subscribe(ctx, "relaunch", "Lead", "Backend Dev", "claude-6666", nil, "mentions") // relaunched under the same name in another role (the launch path)
	require.NoError(t, err)
	after, err := h.bs.GetProjectSubscription(ctx, "relaunch", "Lead")
	require.NoError(t, err)
	assert.Zero(t, after.CanPeek, "the Orchestrator's reads and completion review do not linger on a member that is no longer one")
	got, err := h.bs.TeamOrchestrator(ctx, "relaunch")
	assert.Error(t, err, "and it is not the team's Orchestrator any more")
	assert.Equal(t, "", got)
}

// #11759, QA's minor SHOULD: two members carry the launch record (a team launched with two orchestrator-like seats); the one that is the holder joins again and is let in, and a member that is neither is still refused.
func TestAHolderWithTheLaunchRecordJoinsAgainWhileAnotherHoldsOneToo(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "two", "Orchestrator", "Orchestrator", "claude-7777", nil, "all", true)
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "two", "Orchestrator 2", "Orchestrator", "claude-8888", nil, "all", true)
	require.NoError(t, err)
	join := func(id, title string) int {
		resp := postJSON(t, server.URL+"/api/board/two/subscribe", map[string]string{"subscriber_id": id, "job_title": title})
		defer resp.Body.Close()
		return resp.StatusCode
	}
	assert.Equal(t, http.StatusOK, join("Orchestrator", "Orchestrator"), "the first holder joins again")
	assert.Equal(t, http.StatusOK, join("Orchestrator 2", "Orchestrator"), "and so does the second: each carries the launch record")
	assert.Equal(t, http.StatusConflict, join("Dev", "Orchestrator"), "a member that holds neither is refused")
	sub, err := h.bs.GetProjectSubscription(ctx, "two", "Orchestrator 2")
	require.NoError(t, err)
	assert.NotZero(t, sub.CanPeek, "and the join kept the record")
}
