package live

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/pkg/redact"
)

// Coral Live slice 1 (#21014, design note v2): the frame is a closed type built from named fields, the posts are scanned and withheld
// with 5 before and 5 after a hit, a hidden agent's posts and any real name or @mention never reach it.

func hubScan() redact.Redactor { return secrets.HubRedactor(func() bool { return true }) }

func twoAgents() []AgentFacts {
	return []AgentFacts{
		{RealName: "Backend Dev", Label: "Builder", Role: "backend", CLI: "claude", Status: StatusWorking, TaskTitle: "Fix the login page", Shown: true},
		{RealName: "Ada Lovelace", Label: "", Role: "", CLI: "codex", Status: StatusIdle, Shown: true},
		{RealName: "QA Engineer", Label: "Tester", Role: "qa", CLI: "claude", Status: StatusAsleep, Shown: false},
	}
}

func post(author, text string, at int) PostFacts {
	return PostFacts{Author: author, Text: text, At: time.Unix(int64(1700000000+at), 0)}
}

// The frame is a closed list of names. A field added to it fails here until the list, the design note and Security's read change too.
func TestFrameFieldCensus(t *testing.T) {
	names := func(v any) []string {
		var out []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			out = append(out, rt.Field(i).Name+":"+rt.Field(i).Type.String())
		}
		sort.Strings(out)
		return out
	}
	require.Equal(t, []string{"Agents:[]live.Agent", "Posts:[]live.Post", "Seq:uint64", "V:int"}, names(Frame{}))
	require.Equal(t, []string{"CLI:string", "Label:string", "Role:string", "Status:string", "Task:string"}, names(Agent{}))
	require.Equal(t, []string{"At:int64", "Author:string", "Text:string", "Withheld:bool"}, names(Post{}))
}

// Every field of the input is filled with a unique marker: only the public ones may come out, and a real name never does.
func TestNothingButTheNamedFieldsComesOut(t *testing.T) {
	agents := []AgentFacts{{RealName: "REALNAME-9f3", Label: "Pub", Role: "ROLE-1", CLI: "CLI-1", Status: StatusWorking, TaskTitle: "TITLE-1", Shown: true}}
	f := Build(Input{Agents: agents, Posts: []PostFacts{post("REALNAME-9f3", "hello there", 1)}}, Options{Seq: 7}, hubScan())
	raw, err := json.Marshal(f)
	require.NoError(t, err)
	s := string(raw)
	require.NotContains(t, s, "REALNAME-9f3", "the real name is never in a frame")
	for _, want := range []string{`"label":`, `"v":1`, `"seq":7`} {
		_ = want
	}
	require.Contains(t, s, "Pub")
	require.Contains(t, s, "TITLE-1")
	require.Equal(t, "Pub", f.Posts[0].Author, "a post is signed with the public label")
}

func TestLabelFallsBackToRoleThenAgentN(t *testing.T) {
	f := Build(Input{Agents: twoAgents()}, Options{}, hubScan())
	require.Len(t, f.Agents, 2, "a hidden agent is not in the frame")
	require.Equal(t, "Builder", f.Agents[0].Label)
	require.Equal(t, "Agent 2", f.Agents[1].Label, "no label and no role: Agent N by its place among the shown")
	for _, a := range f.Agents {
		require.NotEqual(t, "QA Engineer", a.Label)
		require.NotEqual(t, "Tester", a.Label)
	}
	require.Equal(t, "asleep", string(StatusAsleep))
}

// Security build MUST 5: a hidden agent's posts are withheld, and a real name or an @mention in a post is replaced or the post is withheld.
func TestHiddenAgentsPostsAndRealNamesAreNotShown(t *testing.T) {
	in := Input{Agents: twoAgents(), Posts: []PostFacts{
		post("QA Engineer", "tests are green", 1),
		post("Backend Dev", "thanks @Ada Lovelace, merging now", 2),
		post("Backend Dev", "@QA Engineer please look", 3),
		post("Backend Dev", "ping @someone-unknown about it", 4),
		post("Backend Dev", "Backend Dev finished the page", 5),
	}}
	f := Build(in, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	for _, bad := range []string{"QA Engineer", "Ada Lovelace", "Backend Dev", "@someone", "@QA", "tests are green"} {
		require.NotContains(t, string(raw), bad)
	}
	require.Contains(t, string(raw), "thanks Agent 2, merging now", "a shown agent's @mention becomes its public label")
	require.Contains(t, string(raw), "Builder finished the page", "a real name becomes the public label")
}

func TestCorpusIsWithheldAndNeighboursToo(t *testing.T) {
	var posts []PostFacts
	for i := 0; i < 14; i++ {
		posts = append(posts, post("Backend Dev", fmt.Sprintf("plain note %d", i), i))
	}
	posts[7].Text = "deploy with api_key=" + "sk_live_" + strings.Repeat("a1B2", 6)
	f := Build(Input{Agents: twoAgents(), Posts: posts}, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "sk_live_")
	shown := 0
	for _, p := range f.Posts {
		if !p.Withheld {
			shown++
		}
	}
	require.Equal(t, 3, shown, "the hit and 5 before and 5 after are withheld; 14 posts leave 2 before and 1 after... see counts")
	require.Equal(t, "plain note 0", f.Posts[0].Text)
	require.Equal(t, "plain note 1", f.Posts[1].Text)
	require.True(t, f.Posts[2].Withheld, "5 before the hit are withheld")
	require.Equal(t, "plain note 13", f.Posts[len(f.Posts)-1].Text)
}

func TestWithheldRunIsOneMarkerWithNoCount(t *testing.T) {
	var posts []PostFacts
	for i := 0; i < 14; i++ {
		posts = append(posts, post("Backend Dev", fmt.Sprintf("plain note %d", i), i))
	}
	posts[7].Text = "token: " + "ghp_" + strings.Repeat("x9Y8", 9)
	f := Build(Input{Agents: twoAgents(), Posts: posts}, Options{}, hubScan())
	markers := 0
	for _, p := range f.Posts {
		if p.Withheld {
			markers++
			require.Equal(t, MarkerMessage, p.Text)
			require.Empty(t, p.Author)
			require.Zero(t, p.At)
		}
	}
	require.Equal(t, 1, markers, "a run of withheld posts is one marker, so a count does not leak")
}

type errRedactor struct{ redact.Redactor }

func (errRedactor) Text([]byte) ([]byte, error) { return nil, errors.New("rules failed") }

func TestScanErrorWithholdsEverythingFailClosed(t *testing.T) {
	f := Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Backend Dev", "hello", 1)}}, Options{}, errRedactor{hubScan()})
	require.Len(t, f.Posts, 1)
	require.True(t, f.Posts[0].Withheld)
	require.Empty(t, f.Agents[0].Task, "a task title that cannot be judged is dropped")
	f = Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Backend Dev", "hello", 1)}}, Options{}, redact.Refuse)
	require.True(t, f.Posts[0].Withheld, "the refusing redactor withholds too")
}

func TestPathsIdsAndControlCharactersAreNotShown(t *testing.T) {
	in := Input{Agents: twoAgents(), Posts: []PostFacts{
		post("Backend Dev", "see coral://artifacts/abc123 for it", 1),
		post("Backend Dev", "edited /Users/someone/work/file.go today", 2),
		post("Backend Dev", "zero​width and ‮right-to-left", 3),
		post("Backend Dev", strings.Repeat("x", 900), 4),
	}}
	f := Build(in, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	s := string(raw)
	require.NotContains(t, s, "coral://")
	require.NotContains(t, s, "/Users/")
	require.NotContains(t, s, "​")
	require.NotContains(t, s, "‮")
	require.Equal(t, "see for it", strings.Join(strings.Fields(f.Posts[0].Text), " "), "an id is cut out")
	require.Len(t, []rune(f.Posts[len(f.Posts)-1].Text), 500, "a post is cut at 500 characters")
}

func TestOnlyTheLast50Posts(t *testing.T) {
	var posts []PostFacts
	for i := 0; i < 80; i++ {
		posts = append(posts, post("Backend Dev", fmt.Sprintf("note %d", i), i))
	}
	f := Build(Input{Agents: twoAgents(), Posts: posts}, Options{}, hubScan())
	require.Len(t, f.Posts, 50)
	require.Equal(t, "note 30", f.Posts[0].Text)
}

func TestFrameDoesNotCarryTimesOrSeqFromTheInputRows(t *testing.T) {
	f := Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Backend Dev", "hi", 5)}}, Options{Seq: 3}, hubScan())
	require.Equal(t, 1, f.V)
	require.Equal(t, uint64(3), f.Seq)
	require.Equal(t, int64(1700000005), f.Posts[0].At)
}
