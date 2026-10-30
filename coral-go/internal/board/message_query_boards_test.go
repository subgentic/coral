package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11048: a search reaches one board (Project) or a set of boards by key (Boards); there is no "every board".
func TestQueryMessagesBoardSets(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	keys := map[string]string{}
	for _, name := range []string{"one", "two", "three"} {
		b, err := s.CreateBoard(ctx, name, "Operator")
		require.NoError(t, err)
		keys[name] = b.ID
		_, err = s.Subscribe(ctx, b.ID, "M-"+name, "Member", "", nil, "all")
		require.NoError(t, err)
		_, err = s.PostMessage(ctx, b.ID, "M-"+name, "SETWORD in "+name, nil)
		require.NoError(t, err)
	}
	run := func(mut func(q *MessageQuery)) string {
		q, err := ParseMessageQuery(MessageQueryParams{Q: []string{"SETWORD"}})
		require.NoError(t, err)
		mut(q)
		res, err := s.QueryMessages(ctx, q)
		require.NoError(t, err)
		out := ""
		for _, m := range res.Messages {
			out += m.Content + ";"
		}
		return out
	}
	one := run(func(q *MessageQuery) { q.Project = keys["one"] })
	assert.Contains(t, one, "in one")
	assert.NotContains(t, one, "in two")

	set := run(func(q *MessageQuery) { q.Boards = []string{keys["one"], keys["three"]} })
	assert.Contains(t, set, "in one")
	assert.Contains(t, set, "in three")
	assert.NotContains(t, set, "in two", "a board outside the set is not searched")

	// An empty set searches nothing, never everything.
	none := run(func(q *MessageQuery) { q.Boards = []string{} })
	assert.Equal(t, "", none)
}
