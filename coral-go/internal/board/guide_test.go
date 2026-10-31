package board

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11457: the guide role's board half: the roster, a guide's message and the history a guide reads.

func TestTheRosterKeepsOnlyLabelsAndNamesThatAreNotAWayToCarryAnAddress(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	got, err := s.GetGuideRoster(ctx, "team")
	require.NoError(t, err)
	assert.Empty(t, got)
	saved, err := s.SetGuideRoster(ctx, "team", map[string]string{"hub-user-1234abcd": "  Dana   Reyes ", "hub-user-00000001": "Sam"})
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"hub-user-1234abcd": "Dana Reyes", "hub-user-00000001": "Sam"}, saved)
	got, _ = s.GetGuideRoster(ctx, "team")
	assert.Equal(t, saved, got)
	other, _ := s.GetGuideRoster(ctx, "other")
	assert.Empty(t, other, "one board's roster is not another's")

	for name, roster := range map[string]map[string]string{
		"an email":         {"hub-user-1234abcd": "dana@example.com"},
		"a mention":        {"hub-user-1234abcd": "@all"},
		"a link":           {"hub-user-1234abcd": "see http://evil.test"},
		"markup":           {"hub-user-1234abcd": "<b>Dana</b>"},
		"the Operator":     {"hub-user-1234abcd": "Operator"},
		"empty":            {"hub-user-1234abcd": "  "},
		"a bad label":      {"someone": "Dana"},
		"a label of 9 hex": {"hub-user-1234abcde": "Dana"},
	} {
		_, err := s.SetGuideRoster(ctx, "team", roster)
		assert.ErrorIs(t, err, ErrGuideRoster, name)
	}
	many := map[string]string{}
	for i := 0; i <= MaxGuideRoster; i++ {
		many["hub-user-"+strings.Repeat("0", 7)+string(rune('a'+i%6))] = "N"
	}
	for i := 0; i <= MaxGuideRoster; i++ {
		many["hub-user-"+strings.Repeat("1", 6)+string("0123456789abcdef"[i/16])+string("0123456789abcdef"[i%16])] = "N"
	}
	_, err = s.SetGuideRoster(ctx, "team", many)
	assert.ErrorIs(t, err, ErrGuideRoster, "more than the most")
	got, _ = s.GetGuideRoster(ctx, "team")
	assert.Equal(t, saved, got, "a refused roster changes nothing")
	assert.Equal(t, "a guide", GuideName(got, "hub-user-ffffffff"), "a label the roster does not name")
	assert.Equal(t, strings.Repeat("x", MaxGuideName), CleanGuideName(strings.Repeat("x", 80)))
}

func TestAGuidesMessageHasItsOwnOriginAndSender(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	m, err := s.PostGuideMessage(ctx, "team", "hub-user-1234abcd", "[Guide Dana, via Coral Hub] hello")
	require.NoError(t, err)
	require.NotNil(t, m.Origin)
	assert.Equal(t, OriginHubGuide, *m.Origin)
	assert.Equal(t, "hub-user-1234abcd", m.SubscriberID)
}

func TestAGuideReadsTheBoardFromTheDayTheGrantWasAcceptedAndNothingAddressedToAGroup(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	old, err := s.PostMessage(ctx, "team", "Lead", "before the grant", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET created_at = ? WHERE id = ?`, time.Now().UTC().Add(-48*time.Hour).Format(time.RFC3339), old.ID)
	require.NoError(t, err)
	since := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	_, err = s.PostMessage(ctx, "team", "Lead", "after the grant", nil)
	require.NoError(t, err)
	grp := "group-1"
	_, err = s.PostMessage(ctx, "team", "Lead", "for a group only", &grp)
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "other", "Lead", "another board", nil)
	require.NoError(t, err)
	got, err := s.ListGuideMessagesSince(ctx, "team", since, 50)
	require.NoError(t, err)
	var texts []string
	for _, m := range got {
		texts = append(texts, m.Content)
	}
	assert.Equal(t, []string{"after the grant"}, texts)
	for i := 0; i < 5; i++ {
		_, err = s.PostMessage(ctx, "team", "Lead", "more", nil)
		require.NoError(t, err)
	}
	got, _ = s.ListGuideMessagesSince(ctx, "team", since, 3)
	assert.Len(t, got, 3, "the limit holds")
	assert.Less(t, got[0].ID, got[2].ID, "oldest first")
}

// Security's SHOULDs on slice B: a guide reads a closed projection that leaves out cross-team messages and Coral Hub's link notices, a roster name cannot read as a member, and the counts the handlers limit by.
func TestAGuideReadsAClosedProjectionWithoutCrossTeamMessages(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	since := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	_, err := s.PostMessage(ctx, "team", "Lead", "plain", nil)
	require.NoError(t, err)
	ext, err := s.PostMessage(ctx, "team", "Lead", "a message of another team", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET external_json = ? WHERE id = ?`, `{"source":"other"}`, ext.ID)
	require.NoError(t, err)
	notice, err := s.PostMessage(ctx, "team", "Coral", "the hub's notice about a link", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET origin = ? WHERE id = ?`, OriginHubNotice, notice.ID)
	require.NoError(t, err)
	got, err := s.ListGuideMessagesSince(ctx, "team", since, 50)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "plain", got[0].Content)
	b, err := json.Marshal(got[0])
	require.NoError(t, err)
	var keys map[string]any
	require.NoError(t, json.Unmarshal(b, &keys))
	for k := range keys {
		assert.Contains(t, []string{"id", "subscriber_id", "job_title", "content", "created_at", "origin", "is_system"}, k, "a field outside the closed projection")
	}
}

func TestARosterNameCannotBeAMembersIdOrJobTitle(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Orchestrator", "Team Lead", "tmux-o", nil, "all")
	require.NoError(t, err)
	for _, name := range []string{"Orchestrator", "orchestrator", " TEAM LEAD "} {
		_, err := s.SetGuideRoster(ctx, "team", map[string]string{"hub-user-1234abcd": name})
		assert.ErrorIs(t, err, ErrGuideRoster, name)
	}
	_, err = s.SetGuideRoster(ctx, "team", map[string]string{"hub-user-1234abcd": "Dana"})
	require.NoError(t, err)
	assert.Equal(t, "Dana", s.GuideDisplayName(ctx, "team", "hub-user-1234abcd"))
	// a member who takes the name later: the board stops writing it
	_, err = s.Subscribe(ctx, "team", "Dana", "Developer", "tmux-d", nil, "all")
	require.NoError(t, err)
	assert.Equal(t, "a guide", s.GuideDisplayName(ctx, "team", "hub-user-1234abcd"), "the name is a member's now")
	assert.Equal(t, "a guide", s.GuideDisplayName(ctx, "team", "hub-user-ffffffff"), "no name at all")
}

func TestTheCountsThatLimitAGuide(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	hourAgo := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	for i := 0; i < 3; i++ {
		_, err := s.PostGuideMessage(ctx, "team", "hub-user-1234abcd", "x")
		require.NoError(t, err)
	}
	_, err := s.PostGuideMessage(ctx, "team", "hub-user-00000001", "y")
	require.NoError(t, err)
	_, err = s.PostGuideMessage(ctx, "other", "hub-user-1234abcd", "z")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "team", "hub-user-1234abcd", "not a guide's post", nil)
	require.NoError(t, err)
	n, err := s.CountGuideMessagesSince(ctx, "team", "hub-user-1234abcd", hourAgo)
	require.NoError(t, err)
	assert.Equal(t, 3, n, "this label's guide posts on this board only")
	_, _, err = s.CreateProposal(ctx, ProposalInput{Board: "team", Kind: ProposalGoal, Title: "g1", Payload: []byte(`{"title":"g1"}`), Proposer: "hub-user-1234abcd"})
	require.NoError(t, err)
	n, err = s.CountProposalsSince(ctx, "team", "hub-user-1234abcd", hourAgo)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	n, _ = s.CountProposalsSince(ctx, "team", "hub-user-00000001", hourAgo)
	assert.Equal(t, 0, n)
}
