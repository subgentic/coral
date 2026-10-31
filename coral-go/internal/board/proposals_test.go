package board

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11389: the store's rules for planning limits and proposals: off by default, the cap counts what waits, the one-per-title merge, the claim that makes a proposal once, and expiry that keeps what it expires.

func proposalOf(title string) ProposalInput {
	b, _ := json.Marshal(map[string]string{"title": title})
	return ProposalInput{Board: "team", Kind: ProposalGoal, Title: title, Payload: b, Proposer: "Orchestrator"}
}

func setPlanning(t *testing.T, s *Store, u BoardSettingsUpdate) {
	t.Helper()
	_, err := s.UpdateBoardSettings(context.Background(), "team", u)
	require.NoError(t, err)
}

func TestPlanningSettingsAreOffByDefault(t *testing.T) {
	s := testStore(t)
	got, err := s.PlanningSettings(context.Background(), "team")
	require.NoError(t, err)
	assert.Equal(t, ProposalSettings{}, got, "no cap, no approval: a team that never set them is unchanged")
	for i := 0; i < 30; i++ {
		newGoal(t, s, "team", "goal "+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
}

func TestTheGoalCapCountsOpenGoalsAndWaitingProposals(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	three := 3
	setPlanning(t, s, BoardSettingsUpdate{MaxOpenGoals: &three})
	newGoal(t, s, "team", "one")
	_, existed, err := s.CreateProposal(ctx, proposalOf("two (waiting)"))
	require.NoError(t, err)
	require.False(t, existed)
	newGoal(t, s, "team", "three")
	_, err = s.CreateGoal(ctx, "team", GoalInput{Title: "four"})
	var ge *GoalError
	require.ErrorAs(t, err, &ge)
	assert.Equal(t, "goal_limit", ge.Code)
	assert.Contains(t, ge.Message, "this team allows 3 open goals")
	_, _, err = s.CreateProposal(ctx, proposalOf("five"))
	require.ErrorAs(t, err, &ge, "a goal proposal past the cap is refused too")
	// a closed goal gives its place back
	g := newGoalByTitle(t, s, "one")
	_, _, err = s.CloseGoal(ctx, "team", g.ID, "done", GoalDone)
	require.NoError(t, err)
	newGoal(t, s, "team", "six")
	// a board with no cap is not held, and another board's goals do not count
	other, err := s.CreateGoal(ctx, "elsewhere", GoalInput{Title: "x"})
	require.NoError(t, err)
	assert.NotZero(t, other.ID)
	// the cap is bounded
	big := MaxOpenGoalsCeiling + 1
	_, err = s.UpdateBoardSettings(ctx, "team", BoardSettingsUpdate{MaxOpenGoals: &big})
	require.Error(t, err)
}

func newGoalByTitle(t *testing.T, s *Store, title string) *Goal {
	t.Helper()
	page, err := s.GoalPage(context.Background(), "team", GoalListQuery{})
	require.NoError(t, err)
	for i := range page.Goals {
		if page.Goals[i].Title == title {
			return &page.Goals[i]
		}
	}
	t.Fatalf("no goal %q", title)
	return nil
}

func TestTheSameProposalIsOneRowAndAnApprovedGoalKeepsItsPlaceUnderTheCap(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	one := 1
	setPlanning(t, s, BoardSettingsUpdate{MaxOpenGoals: &one})
	a, existed, err := s.CreateProposal(ctx, proposalOf("Ship the beta"))
	require.NoError(t, err)
	require.False(t, existed)
	b, existed, err := s.CreateProposal(ctx, proposalOf("  ship   THE beta "))
	require.NoError(t, err)
	assert.True(t, existed)
	assert.Equal(t, a.ID, b.ID)
	claimed, err := s.ClaimProposal(ctx, "team", a.ID)
	require.NoError(t, err)
	g, err := s.CreateGoalApproved(ctx, "team", claimed.ID, GoalInput{Title: "Ship the beta", CreatedBy: "Orchestrator"})
	require.NoError(t, err, "the proposal's own place under the cap is not counted twice")
	require.NoError(t, s.FinishProposal(ctx, "team", claimed.ID, g.ID))
	done, err := s.GetProposal(ctx, "team", a.ID)
	require.NoError(t, err)
	assert.Equal(t, ProposalApproved, done.State)
	require.NotNil(t, done.CreatedRef)
	assert.Equal(t, g.ID, *done.CreatedRef)
}

func TestAProposalIsClaimedByOneApproveOnly(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	p, _, err := s.CreateProposal(ctx, proposalOf("Only once"))
	require.NoError(t, err)
	var wg sync.WaitGroup
	wins := make(chan struct{}, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.ClaimProposal(ctx, "team", p.ID); err == nil {
				wins <- struct{}{}
			}
		}()
	}
	wg.Wait()
	close(wins)
	n := 0
	for range wins {
		n++
	}
	assert.Equal(t, 1, n, "twenty Approves at once: one makes it")
	_, err = s.RejectProposal(ctx, "team", p.ID, "too late")
	assert.ErrorIs(t, err, ErrProposalNotOpen, "a claimed proposal cannot be rejected")
	require.NoError(t, s.ReleaseProposal(ctx, "team", p.ID))
	_, err = s.RejectProposal(ctx, "team", p.ID, "now it can")
	require.NoError(t, err)
	_, err = s.ClaimProposal(ctx, "team", p.ID)
	assert.ErrorIs(t, err, ErrProposalNotOpen, "a rejected one is decided")
	_, err = s.ClaimProposal(ctx, "team", 9999)
	assert.ErrorIs(t, err, ErrProposalNotFound)
}

func TestAnExpiredProposalIsKeptAndNotClaimable(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	p, _, err := s.CreateProposal(ctx, proposalOf("Stale idea"))
	require.NoError(t, err)
	none, err := s.ExpireProposals(ctx, time.Now())
	require.NoError(t, err)
	assert.Empty(t, none, "not before 7 days")
	gone, err := s.ExpireProposals(ctx, time.Now().Add(ProposalTTL+time.Hour))
	require.NoError(t, err)
	require.Len(t, gone, 1)
	again, err := s.ExpireProposals(ctx, time.Now().Add(ProposalTTL+time.Hour))
	require.NoError(t, err)
	assert.Empty(t, again, "expired once")
	kept, err := s.GetProposal(ctx, "team", p.ID)
	require.NoError(t, err)
	assert.Equal(t, ProposalExpired, kept.State, "kept, marked, not deleted")
	list, err := s.ListProposals(ctx, "", ProposalExpired)
	require.NoError(t, err)
	assert.Len(t, list, 1)
	first, err := s.MarkProposalNotified(ctx, "team", p.ID)
	require.NoError(t, err)
	second, err := s.MarkProposalNotified(ctx, "team", p.ID)
	require.NoError(t, err)
	assert.True(t, first)
	assert.False(t, second, "the proposer is told once")
}

func TestATaskProposalWaitsForItsGoalProposal(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g, _, err := s.CreateProposal(ctx, proposalOf("A goal"))
	require.NoError(t, err)
	_, err = s.GoalOfProposal(ctx, "team", g.ID)
	assert.ErrorIs(t, err, ErrProposalWaitsGoal)
	_, err = s.RejectProposal(ctx, "team", g.ID, "no")
	require.NoError(t, err)
	_, err = s.GoalOfProposal(ctx, "team", g.ID)
	assert.ErrorIs(t, err, ErrProposalGoalGone, "a rejected goal takes its tasks' chance with it")
}
