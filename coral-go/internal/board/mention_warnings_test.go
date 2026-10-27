package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var warnNames = []string{"Lead Developer", "Digital Ocean Expert", "Security Reviewer", "Orchestrator", "QA", "Backend Dev"}

func TestMentionWarningsSuggestTheClosestName(t *testing.T) {
	for content, want := range map[string][]string{
		// the example from the request: the name is close to a member's
		"@DO Expert please check the droplet":     {"no subscriber named 'DO Expert'; did you mean 'Digital Ocean Expert'?"},
		"@Digital Ocean Exprt the firewall":       {"no subscriber named 'Digital Ocean Exprt'; did you mean 'Digital Ocean Expert'?"},
		"@Sercurity Reviewer is the patch ready?": {"no subscriber named 'Sercurity Reviewer'; did you mean 'Security Reviewer'?"},
		"@Orchestrater done":                      {"no subscriber named 'Orchestrater'; did you mean 'Orchestrator'?"},
		"@backend dv one more thing":              {"no subscriber named 'backend dv'; did you mean 'Backend Dev'?"},
		// a --to run: each unknown name, with or without a close one
		"@Lead Developer @Nobody Here do it":       {"no subscriber named 'Nobody'"},
		"@Nobody @Security Reviewer hello":         {"no subscriber named 'Nobody'"},
		"@Lead Developer @Sercurity Reviewer ship": {"no subscriber named 'Sercurity Reviewer'; did you mean 'Security Reviewer'?"},
		// in the middle of text: only a close one
		"thanks, @Sercurity Reviewer, for the review":   {"no subscriber named 'Sercurity Reviewer'; did you mean 'Security Reviewer'?"},
		"the decorator @param and @2x are not mentions": nil,
		"mail me at someone@example.com":                nil,
		"see @Orchestrator and @all and @notify-all":    nil,
		"@Operator the release is ready":                nil,
		"@LeadDeveloper spaceless is fine":              nil,
		"@qa @QA @Qa":                                   nil,
		"no mentions at all":                            nil,
		"@Backend Dev 2 is a numbered name":             nil,
	} {
		assert.Equal(t, want, mentionWarnings(content, warnNames), content)
	}
	// at most five, each name once
	got := mentionWarnings("@A1 @B2 @C3 @D4 @E5 @F6 @G7 @A1 x", warnNames)
	assert.Len(t, got, 5)
	assert.Len(t, mentionWarnings("@Zed @zed @ZED hi", warnNames), 1, "each name once, whatever its case")
}

func TestAbbreviations(t *testing.T) {
	assert.True(t, abbreviates([]string{"DO", "Expert"}, "Digital Ocean Expert"))
	assert.True(t, abbreviates([]string{"Dig", "Ocean", "Exp"}, "Digital Ocean Expert"))
	assert.True(t, abbreviates([]string{"LD"}, "Lead Developer"))
	assert.False(t, abbreviates([]string{"DO"}, "Digital Ocean Expert"), "the whole name must be used")
	assert.False(t, abbreviates([]string{"DO", "Cloud"}, "Digital Ocean Expert"))
	assert.False(t, abbreviates([]string{"Lead"}, "Lead"), "a one-word name has nothing to shorten")
}

func TestStoreMentionWarningsUseTheBoardsMembers(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Digital Ocean Expert", "Cloud", "claude-"+"11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "team", "Lead", "Lead Developer", "claude-"+"22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	assert.Equal(t, []string{"no subscriber named 'DO Expert'; did you mean 'Digital Ocean Expert'?"}, s.UnknownMentions(ctx, "team", "@DO Expert are you there"))
	assert.Nil(t, s.UnknownMentions(ctx, "team", "@Lead @Cloud @Lead Developer hello"), "a name, a role and a spaced name are all members")
	assert.Nil(t, s.UnknownMentions(ctx, "team", "no at-sign"))
	assert.Nil(t, s.UnknownMentions(ctx, "elsewhere", "@Lead hello"), "a board with no members names nobody: nothing to compare with")
}

// "@Orchestrator (coral-hub)" is how a message from another team shows its sender: it tags the member here, so it is a problem, with the
// way to reach the other team. A parenthesis that is not another board's name is prose.
func TestCrossTeamSenderMentions(t *testing.T) {
	boards := map[string]string{"coral-hub": "coral-hub", "hub team": "coral-hub"}
	for content, want := range map[string][]string{
		"@Orchestrator (coral-hub) please look": {"no subscriber named 'Orchestrator (coral-hub)': that is a sender on another team's board; message it with: coral-board send --board coral-hub \"...\""},
		"thanks @orchestrator (Hub Team)":       {"no subscriber named 'orchestrator (Hub Team)': that is a sender on another team's board; message it with: coral-board send --board coral-hub \"...\""},
		"@Orchestrator (see above) is fine":     nil,
		"@Orchestrator (coral-hub is unclosed":  nil,
		"@Orchestrator is fine (coral-hub)":     nil,
		"mail@Orchestrator (coral-hub)":         nil,
		"@Nobody (coral-hub)":                   nil, // not a member: mentionWarnings names it
	} {
		assert.Equal(t, want, crossTeamMentions(content, warnNames, boards), content)
	}
	assert.Nil(t, crossTeamMentions("@Orchestrator (coral-hub)", warnNames, nil), "no other board: nothing to compare with")
}

func TestUnknownMentionsKnowsTheOtherBoards(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "coral-hub", "Lead", "Lead", "claude-33333333-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	got := s.UnknownMentions(ctx, "team", "@Orchestrator (coral-hub) hi")
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "coral-board send --board coral-hub")
	assert.Nil(t, s.UnknownMentions(ctx, "team", "@Orchestrator (team) hi"), "its own board's name is no other team")
	assert.Nil(t, s.UnknownMentions(ctx, "team", "@Orchestrator hi"))
}

// A name with a letter whose lower-case is shorter in bytes (U+0130) is sliced by its own length, not the lower-cased copy's: no panic, and the name is cut whole (#9068).
func TestMentionsWithALetterThatLowersToAShorterByteLengthDoNotPanic(t *testing.T) {
	names := []string{"İstanbul Dev", "Orchestrator"}
	boards := map[string]string{"coral-hub": "coral-hub"}
	assert.NotPanics(t, func() {
		got := crossTeamMentions("@İstanbul Dev (coral-hub) hi, @Orchestrator (coral-hub)", names, boards)
		require.Len(t, got, 2)
		assert.Contains(t, got[0], "'İstanbul Dev (coral-hub)'", "the name is shown as written")
		assert.Nil(t, mentionWarnings("@İstanbul Dev, look at this", names), "a member with that letter is known")
		assert.Nil(t, mentionWarnings("İİİİİİ @istanbul dev and @Orchestrator", names))
		assert.Len(t, mentionWarnings("@İİİİ @Orchestrator", names), 1, "an unknown name made of such letters is named whole")
	})
	assert.Equal(t, 2, knownLenIn("İ ok", map[string]bool{"i": true}), "the length is of the original text")
}

func TestOtherBoardNamesIsOneQueryOfIdsAndLabels(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, id := range []string{"team", "coral-hub", "other"} {
		_, err := s.Subscribe(ctx, id, "Member", "Dev", "claude-"+id, nil, "all")
		require.NoError(t, err)
	}
	got := s.otherBoardNames(ctx, "team")
	assert.Equal(t, "coral-hub", got["coral-hub"])
	assert.Equal(t, "other", got["other"])
	assert.NotContains(t, got, "team", "the board itself is no other team")
}
