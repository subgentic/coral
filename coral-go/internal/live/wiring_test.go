package live

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

// The wiring slice (#21014): posts oldest first, a row with no key is never shown, and the board source reads this team's public board only.

func TestPostsComeOldestFirstEvenFromASourceThatGivesThemNewestFirst(t *testing.T) {
	src := fakeSource{agents: rows(), posts: []PostRow{
		{Author: "Backend Dev", Text: "third", At: time.Unix(1700000003, 0)},
		{Author: "Backend Dev", Text: "first", At: time.Unix(1700000001, 0)},
		{Author: "Backend Dev", Text: "second", At: time.Unix(1700000002, 0)},
	}}
	in, err := Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"s1": true}})
	require.NoError(t, err)
	var got []string
	for _, p := range in.Posts {
		got = append(got, p.Text)
	}
	require.Equal(t, []string{"first", "second", "third"}, got)
}

func TestAnAgentRowWithNoKeyIsNeverShownButItsNameIsStillKnown(t *testing.T) {
	src := fakeSource{agents: []AgentRow{
		{Key: "s1", Name: "Backend Dev", Role: "backend"},
		{Key: "", Name: "Keyless Kim", Role: "qa", Working: true},
	}, posts: []PostRow{{Author: "Backend Dev", Text: "ping Keyless Kim", At: time.Unix(1700000001, 0)}}}
	// even a choice map that has an entry for the empty key does not show it
	in, err := Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"": true, "s1": true}})
	require.NoError(t, err)
	f := Build(in, Options{}, hubScan())
	require.Len(t, f.Agents, 1)
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "Keyless", "the name is replaced or the post withheld")
}

func TestBoardSourceReadsThisTeamsPublicBoardOnly(t *testing.T) {
	ctx := context.Background()
	st, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	for _, s := range []struct{ proj, id, title string }{{"team", "Backend Dev", "backend"}, {"team", "Gone Gus", "ux"}, {"other", "Other Olga", "lead"}} {
		_, err := st.Subscribe(ctx, s.proj, s.id, s.title, "sess-"+s.id, nil, "all")
		require.NoError(t, err)
	}
	_, err = st.Unsubscribe(ctx, "team", "Gone Gus")
	require.NoError(t, err)
	post := func(proj, who, text string) {
		_, err := st.PostMessage(ctx, proj, who, text, nil)
		require.NoError(t, err)
	}
	post("team", "Backend Dev", "first team post")
	post("other", "Other Olga", "secret of the other team")
	g := "private-group"
	_, err = st.PostMessage(ctx, "team", "Backend Dev", "a private group message", &g)
	require.NoError(t, err)
	post("team", "Backend Dev", "second team post")

	src := NewBoardSource(st, "team", func(string) AgentState { return AgentState{Working: true} })
	agents, err := src.Agents(ctx)
	require.NoError(t, err)
	names := map[string]bool{}
	for _, a := range agents {
		require.NotEmpty(t, a.Key)
		names[a.Name] = true
	}
	require.True(t, names["Backend Dev"])
	require.True(t, names["Gone Gus"], "an agent that has left is still handed over, so its name is known")
	require.False(t, names["Other Olga"], "another team's agent is not this team's")

	posts, err := src.Posts(ctx, 50)
	require.NoError(t, err)
	var texts []string
	for _, p := range posts {
		texts = append(texts, p.Text)
	}
	require.Equal(t, []string{"first team post", "second team post"}, texts, "this team's posts, oldest first, none of the other team's and no group message")
	one, err := src.Posts(ctx, 1)
	require.NoError(t, err)
	require.Len(t, one, 1)
	require.Equal(t, "second team post", one[0].Text, "n keeps the newest")
}

func TestAnAskAndAHubUsersPostAreNotPublicPosts(t *testing.T) {
	ctx := context.Background()
	st, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	_, err = st.Subscribe(ctx, "team", "Backend Dev", "backend", "sess-b", nil, "all")
	require.NoError(t, err)
	_, err = st.PostMessage(ctx, "team", "Backend Dev", "plain post", nil)
	require.NoError(t, err)
	ask, err := st.PostMessage(ctx, "team", "Backend Dev", "@Operator may I ship?", nil)
	require.NoError(t, err)
	require.NoError(t, st.RecordAsk(ctx, "team", ask, []string{"Operator"}))
	_, err = st.PostMessageWithOrigin(ctx, "team", "Backend Dev", "typed by a Hub user", nil, board.OriginHubUser)
	require.NoError(t, err)

	posts, err := NewBoardSource(st, "team", func(string) AgentState { return AgentState{} }).Posts(ctx, 50)
	require.NoError(t, err)
	var texts []string
	for _, p := range posts {
		texts = append(texts, p.Text)
	}
	require.Equal(t, []string{"plain post"}, texts)
}
