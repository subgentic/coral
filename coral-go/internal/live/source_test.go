package live

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Slice 2, the source (#21014): the caller hands over every agent of the team, sleeping and archived too, and a secret split across two posts is caught.

type fakeSource struct {
	agents []AgentRow
	posts  []PostRow
}

func (f fakeSource) Agents(context.Context) ([]AgentRow, error) { return f.agents, nil }
func (f fakeSource) Posts(_ context.Context, n int) ([]PostRow, error) {
	if len(f.posts) > n {
		return f.posts[len(f.posts)-n:], nil
	}
	return f.posts, nil
}

func rows() []AgentRow {
	return []AgentRow{
		{Key: "s1", Name: "Backend Dev", Role: "backend", Working: true},
		{Key: "s2", Name: "Sleeper One", Role: "qa", Sleeping: true},
		{Key: "s3", Name: "Gone Two", Role: "ux", Archived: true},
		{Key: "s4", Name: "Waiter", Role: "lead", Waiting: true},
	}
}

func TestEveryTeamAgentIsHandedOverAndOnlyChosenOnesAreShown(t *testing.T) {
	in, err := Gather(context.Background(), fakeSource{agents: rows()}, ViewChoice{Shown: map[string]bool{"s1": true, "s2": true}})
	require.NoError(t, err)
	require.Len(t, in.Agents, 4, "sleeping and archived agents are in the input, so their names are known to the name rule")
	shown := map[string]bool{}
	for _, a := range in.Agents {
		shown[a.RealName] = a.Shown
	}
	require.Equal(t, map[string]bool{"Backend Dev": true, "Sleeper One": true, "Gone Two": false, "Waiter": false}, shown, "an agent the owner did not choose is hidden, and a new one starts hidden")
	f := Build(in, Options{}, hubScan())
	require.Len(t, f.Agents, 2)
	require.Equal(t, "asleep", f.Agents[1].Status)
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "Gone Two")
}

func TestPostsByAnArchivedAgentAreWithheldAndItsNameNeverAppears(t *testing.T) {
	src := fakeSource{agents: rows(), posts: []PostRow{
		{Author: "Gone Two", Text: "done", At: time.Unix(1700000001, 0)},
		{Author: "Backend Dev", Text: "thanks Gone Two", At: time.Unix(1700000002, 0)},
	}}
	in, err := Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"s1": true}})
	require.NoError(t, err)
	f := Build(in, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "Gone Two")
	require.NotContains(t, string(raw), `"text":"done"`)
}

func TestStatusWordFromTheStoredFlags(t *testing.T) {
	require.Equal(t, StatusAsleep, StatusFrom(AgentRow{Sleeping: true, Working: true}), "asleep wins")
	require.Equal(t, StatusAsleep, StatusFrom(AgentRow{Archived: true}))
	require.Equal(t, StatusWaiting, StatusFrom(AgentRow{Waiting: true, Working: true}))
	require.Equal(t, StatusWorking, StatusFrom(AgentRow{Working: true}))
	require.Equal(t, StatusIdle, StatusFrom(AgentRow{}))
}

// A secret cut in two posts: neither half is a secret alone, together they are.
func TestASecretSplitAcrossTwoPostsIsCaught(t *testing.T) {
	first, second := "AKIAABCD12", "34ABCD1234"
	require.True(t, scan(hubScan(), first), "premise: the first half alone is not a secret")
	require.True(t, scan(hubScan(), second), "premise: the second half alone is not a secret")
	require.False(t, scan(hubScan(), first+second), "premise: together they are")
	var posts []PostFacts
	for i := 0; i < 14; i++ {
		posts = append(posts, post("Backend Dev", "plain note "+string(rune('a'+i)), i))
	}
	posts[6].Text = first
	posts[7].Text = second
	f := Build(Input{Agents: twoAgents(), Posts: posts}, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), first)
	require.NotContains(t, string(raw), second)
}
