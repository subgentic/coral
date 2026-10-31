package board

import (
	"context"
	"encoding/json"
	"strconv"
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

// S6: a clash is filed by an agent from two stored messages and Coral writes ONE question to the Operator, quoting both with their authors and roles.
func TestAClashPutsOneQuestionToTheOperatorQuotingBothDirections(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "team", "Dev", "Developer", "tmux-d", nil, "all")
	require.NoError(t, err)
	_, err = s.SetGuideRoster(ctx, "team", map[string]string{"hub-user-1234abcd": "Dana Reyes"})
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "the report", "", "", "Lead", "Dev")
	require.NoError(t, err)
	target := "task:" + strconv.FormatInt(task.ID, 10)
	guide, err := s.PostGuideMessage(ctx, "team", "hub-user-1234abcd", "[Guide Dana Reyes via Coral Hub, hub-user-1234abcd] use option A @all")
	require.NoError(t, err)
	op, err := s.PostMessage(ctx, "team", "Operator", "use option B", nil)
	require.NoError(t, err)

	res, err := s.FileClash(ctx, "team", target, guide.ID, op.ID, "Orchestrator", time.Now())
	require.NoError(t, err)
	assert.False(t, res.Existed)
	ask, err := s.GetMessageByID(ctx, "team", res.AskID)
	require.NoError(t, err)
	assert.True(t, ask.IsSystem)
	assert.Equal(t, "Coral", ask.SubscriberID)
	for _, want := range []string{target, "guide Dana Reyes said", "the Operator said", "use option A", "use option B", "held"} {
		assert.Contains(t, ask.Content, want)
	}
	assert.NotContains(t, ask.Content, "@all", "a quoted mention does not mention anyone (the @ is followed by a zero-width space)")
	require.NotNil(t, ask.Ask)
	assert.Equal(t, []string{"Operator"}, ask.Ask.To)
	assert.False(t, ask.Ask.Answered)

	// the same target again, the other way round: the same question, nothing new
	again, err := s.FileClash(ctx, "team", target, op.ID, guide.ID, "Dev", time.Now())
	require.NoError(t, err)
	assert.True(t, again.Existed)
	assert.Equal(t, res.AskID, again.AskID)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_clashes WHERE project = 'team'`))
	assert.Equal(t, 1, n)

	// the Operator decides: the question closes, and the target can be filed again
	require.NoError(t, s.CloseAsk(ctx, "team", res.AskID, "Operator", "decided: B"))
	third, err := s.FileClash(ctx, "team", target, guide.ID, op.ID, "Dev", time.Now())
	require.NoError(t, err)
	assert.False(t, third.Existed)
	assert.NotEqual(t, res.AskID, third.AskID)
}

func TestWhatIsNotAClashIsRefused(t *testing.T) {
	s := orchStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	task, err := s.CreateTask(ctx, "team", "t", "", "", "Lead", "Operator")
	require.NoError(t, err)
	target := "task:" + strconv.FormatInt(task.ID, 10)
	g1, _ := s.PostGuideMessage(ctx, "team", "hub-user-1234abcd", "A")
	g1b, _ := s.PostGuideMessage(ctx, "team", "hub-user-1234abcd", "B")
	g2, _ := s.PostGuideMessage(ctx, "team", "hub-user-00000001", "B different")
	op, _ := s.PostMessage(ctx, "team", "Operator", "C", nil)
	dev, _ := s.PostMessage(ctx, "team", "Dev", "D", nil)
	dev2, _ := s.PostMessage(ctx, "team", "Lead", "E", nil)
	grp := "g1"
	private, _ := s.PostMessage(ctx, "team", "Operator", "for a group", &grp)
	sys, _ := s.PostSystemMessage(ctx, "team", "Coral", "a system line", nil)
	same, _ := s.PostGuideMessage(ctx, "team", "hub-user-00000001", "  a  ")
	otherBoard, _ := s.PostGuideMessage(ctx, "other", "hub-user-00000001", "elsewhere")
	for name, c := range map[string]struct {
		target string
		a, b   int64
		want   error
	}{
		"the same message twice":        {target, g1.ID, g1.ID, ErrClashMessages},
		"one author twice":              {target, g1.ID, g1b.ID, ErrClashMessages},
		"no guide among them":           {target, op.ID, dev.ID, ErrClashMessages},
		"two agents":                    {target, dev.ID, dev2.ID, ErrClashMessages},
		"a message for a group":         {target, g2.ID, private.ID, ErrClashMessages},
		"a system line":                 {target, g2.ID, sys.ID, ErrClashMessages},
		"a message of another board":    {target, g2.ID, otherBoard.ID, ErrClashMessages},
		"no such message":               {target, g2.ID, 99999, ErrClashMessages},
		"the same words":                {target, g1.ID, same.ID, ErrClashSame},
		"a target that is no form":      {"everything", g1.ID, op.ID, ErrClashTarget},
		"a task of another board":       {"task:9999", g1.ID, op.ID, ErrClashNoTarget},
		"an artifact with a bad digest": {"artifact:abc", g1.ID, op.ID, ErrClashTarget},
	} {
		_, err := s.FileClash(ctx, "team", c.target, c.a, c.b, "Dev", time.Now())
		assert.ErrorIs(t, err, c.want, name)
	}
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_clashes`))
	assert.Equal(t, 0, n, "none of them filed anything")
	// an artifact target needs no lookup of its own (the digest form is the check), and the cap holds
	for i := 0; i < MaxOpenClashes; i++ {
		_, err := s.FileClash(ctx, "team", "artifact:"+strings.Repeat(string("0123456789abcdef"[i]), 64), g1.ID, op.ID, "Dev", time.Now())
		require.NoError(t, err)
	}
	_, err = s.FileClash(ctx, "team", "artifact:"+strings.Repeat("f", 64), g1.ID, op.ID, "Dev", time.Now())
	assert.ErrorIs(t, err, ErrClashTooMany)
}
