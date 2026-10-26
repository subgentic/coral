package board

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8525: the dock's read set is kept between polls and extended from where the last scan stopped.

func readSetBoard(t *testing.T) (*Store, context.Context) {
	t.Helper()
	ctx := context.Background()
	s := testStore(t)
	for name, role := range map[string]string{"Worker": "Backend", "Lead": "Orchestrator", "Poster": "Developer"} {
		_, err := s.Subscribe(ctx, "big", name, role, "claude-"+name, nil, "all")
		require.NoError(t, err)
	}
	return s, ctx
}

func postReadSet(t *testing.T, s *Store, ctx context.Context, who, text string) int64 {
	t.Helper()
	m, err := s.PostMessage(ctx, "big", who, text, nil)
	require.NoError(t, err)
	return m.ID
}

// uncachedReadSet is what ReadSetIDs answers with nothing remembered.
func uncachedReadSet(t *testing.T, s *Store, ctx context.Context, who string) []int64 {
	t.Helper()
	s.readSets.mu.Lock()
	s.readSets.entries = nil
	s.readSets.mu.Unlock()
	ids, err := s.ReadSetIDs(ctx, "big", who)
	require.NoError(t, err)
	return ids
}

// A second poll with nothing new scans nothing; a poll after one new message scans from where the last stopped, and finds what a scan of everything finds.
func TestASecondDockPollScansOnlyWhatIsNew(t *testing.T) {
	s, ctx := readSetBoard(t)
	for i := 0; i < 250; i++ {
		postReadSet(t, s, ctx, "Poster", fmt.Sprintf("@Worker %d please look", i))
		postReadSet(t, s, ctx, "Poster", fmt.Sprintf("untagged chatter %d", i))
	}
	for _, who := range []string{"Worker", "Lead"} { // the tagged rule and the orchestrator's
		first, err := s.ReadSetIDs(ctx, "big", who)
		require.NoError(t, err)
		require.NotEmpty(t, first)
		scansAfterFirst := s.readSets.scans.Load()

		again, err := s.ReadSetIDs(ctx, "big", who)
		require.NoError(t, err)
		assert.Equal(t, first, again, who)
		assert.Equal(t, scansAfterFirst, s.readSets.scans.Load(), "%s: nothing new on the board: no scan at all", who)

		postReadSet(t, s, ctx, "Poster", "@Worker one more for you")
		postReadSet(t, s, ctx, "Poster", "and a chat line")
		third, err := s.ReadSetIDs(ctx, "big", who)
		require.NoError(t, err)
		assert.Equal(t, scansAfterFirst+1, s.readSets.scans.Load(), "%s: one scan, of what is new", who)
		assert.Equal(t, uncachedReadSet(t, s, ctx, who), third, "%s: the same set a full scan finds", who)
		assert.Greater(t, len(third), len(first), who)
	}
}

// What is kept is dropped when what it was made from changes: a deleted message leaves the set, and a member whose role changed is read by the new rule.
func TestTheDocksReadSetIsDroppedWhenItsInputsChange(t *testing.T) {
	s, ctx := readSetBoard(t)
	keep := postReadSet(t, s, ctx, "Poster", "@Worker keep this")
	gone := postReadSet(t, s, ctx, "Poster", "@Worker delete this")
	chat := postReadSet(t, s, ctx, "Poster", "no tag here")
	set, err := s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{keep, gone}, set)

	ok, err := s.DeleteMessage(ctx, "big", gone)
	require.NoError(t, err)
	require.True(t, ok)
	set, err = s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{keep}, set, "a deleted message is not in the set any more")

	// made an orchestrator: it reads everything from others, so the chat line is in
	_, err = s.Subscribe(ctx, "big", "Worker", "Orchestrator", "claude-Worker", nil, "all")
	require.NoError(t, err)
	set, err = s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Contains(t, set, chat, "the new role's rule applies at once")
	assert.Equal(t, uncachedReadSet(t, s, ctx, "Worker"), set)
}

// A member's own posts come in as they are made, once each, whether or not they tag the member.
func TestTheDocksReadSetTakesNewOwnPostsOnce(t *testing.T) {
	s, ctx := readSetBoard(t)
	postReadSet(t, s, ctx, "Poster", "@Worker hello")
	first, err := s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	mine := postReadSet(t, s, ctx, "Worker", "my own reply")
	selfTag := postReadSet(t, s, ctx, "Worker", "a note to @Worker myself")
	set, err := s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, append(append([]int64{}, first...), mine, selfTag), set)
	assert.Equal(t, uncachedReadSet(t, s, ctx, "Worker"), set)
}

// Own posts, a poll, more own posts, a poll: each own post is in the set once (the second poll takes only the posts above what the first had; Security's mutant that took them all again gave the first twice).
func TestTheDocksReadSetTakesOwnPostsOnceAcrossPolls(t *testing.T) {
	s, ctx := readSetBoard(t)
	first := postReadSet(t, s, ctx, "Worker", "my first reply")
	set, err := s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{first}, set)

	second := postReadSet(t, s, ctx, "Worker", "my second reply")
	set, err = s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{first, second}, set, "the first own post is not taken again")
	assert.Equal(t, uncachedReadSet(t, s, ctx, "Worker"), set)

	// and a tagged post by someone else between two own ones, polled each time
	other := postReadSet(t, s, ctx, "Poster", "@Worker over to you")
	third := postReadSet(t, s, ctx, "Worker", "my third reply")
	set, err = s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{first, second, other, third}, set)
	set, err = s.ReadSetIDs(ctx, "big", "Worker")
	require.NoError(t, err)
	assert.Equal(t, []int64{first, second, other, third}, set, "and a poll with nothing new says the same")
}

// A mix of members' polls and posts, in any order, always gives what a full scan gives.
func TestTheDocksReadSetAlwaysEqualsAFullScan(t *testing.T) {
	s, ctx := readSetBoard(t)
	texts := []string{"@Worker task %d", "chatter %d", "@all notice %d", "@Backend role tag %d", "plain %d"}
	for i := 0; i < 120; i++ {
		who := []string{"Poster", "Worker", "Lead"}[i%3]
		postReadSet(t, s, ctx, who, fmt.Sprintf(texts[i%len(texts)], i))
		if i%7 == 0 {
			for _, member := range []string{"Worker", "Lead", "Poster"} {
				got, err := s.ReadSetIDs(ctx, "big", member)
				require.NoError(t, err)
				want := uncachedReadSet(t, s, ctx, member)
				require.Equal(t, want, got, "after %d posts, for %s", i+1, member)
			}
		}
	}
}

// An entry is used only for the rule, the numbered names and the deletions it was made from: each of the four differing is a miss (they change through other paths too, so each is pinned alone).
func TestAReadSetEntryIsUsedOnlyForWhatItWasMadeFrom(t *testing.T) {
	var c readSetCache
	rule := &readRule{subscriberID: "Worker", jobTitle: "Backend", tagged: true}
	c.put(readSetEntry{project: "p", subscriberID: "Worker", jobTitle: "Backend", tagged: true, numberedGen: 4, gen: c.gen.Load(), upTo: 9, read: []int64{3, 9}})

	got, ok := c.get("p", "Worker", rule, 4)
	require.True(t, ok)
	assert.Equal(t, []int64{3, 9}, got.read)

	_, ok = c.get("p", "Worker", &readRule{subscriberID: "Worker", jobTitle: "Frontend", tagged: true}, 4)
	assert.False(t, ok, "another job title")
	_, ok = c.get("p", "Worker", &readRule{subscriberID: "Worker", jobTitle: "Backend", tagged: false}, 4)
	assert.False(t, ok, "read by tags or not")
	_, ok = c.get("p", "Worker", &readRule{subscriberID: "Worker", jobTitle: "Backend", tagged: true, none: true}, 4)
	assert.False(t, ok, "a receive mode of none")
	_, ok = c.get("p", "Worker", rule, 5)
	assert.False(t, ok, "the board's numbered names changed")
	_, ok = c.get("p", "Other", rule, 4)
	assert.False(t, ok, "another member")
	_, ok = c.get("q", "Worker", rule, 4)
	assert.False(t, ok, "another board")
	c.invalidate()
	_, ok = c.get("p", "Worker", rule, 4)
	assert.False(t, ok, "a message was deleted")
}
