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
		{RealName: "Backend Dev", Role: "backend", Status: StatusWorking, TaskTitle: "Fix the login page", Shown: true},
		{RealName: "Ada Lovelace", Role: "", Status: StatusIdle, Shown: true},
		{RealName: "QA Engineer", Role: "qa", Status: StatusAsleep, Shown: false},
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
	require.Equal(t, []string{"Chat:[]live.Chat", "Role:string", "Status:string", "Task:string"}, names(Agent{}))
	require.Equal(t, []string{"At:int64", "From:string", "Text:string", "W:bool"}, names(Post{}))
	require.Equal(t, []string{"At:int64", "From:string", "Text:string", "W:bool"}, names(Chat{}))
}

// Every field of the input is filled with a unique marker: only the public ones may come out, and a real name never does.
func TestNothingButTheNamedFieldsComesOut(t *testing.T) {
	agents := []AgentFacts{{RealName: "REALNAME-9f3", Role: "pub-role", Status: StatusWorking, TaskTitle: "TITLE-1", Shown: true}}
	f := Build(Input{Agents: agents, Posts: []PostFacts{post("REALNAME-9f3", "hello there", 1)}}, Options{Seq: 7}, hubScan())
	raw, err := json.Marshal(f)
	require.NoError(t, err)
	s := string(raw)
	require.NotContains(t, s, "REALNAME-9f3", "the real name is never in a frame")
	require.Contains(t, s, `"v":1`)
	require.Contains(t, s, `"seq":7`)
	require.Contains(t, s, "pub-role")
	require.Contains(t, s, "TITLE-1")
	require.NotContains(t, s, "CLI-1", "the CLI is not on the wire")
	require.Equal(t, "pub-role", f.Posts[0].From, "a post is signed with the role")
}

func TestLabelFallsBackToRoleThenAgentN(t *testing.T) {
	f := Build(Input{Agents: twoAgents()}, Options{}, hubScan())
	require.Len(t, f.Agents, 2, "a hidden agent is not in the frame")
	require.Equal(t, "backend", f.Agents[0].Role)
	require.Equal(t, "Agent 2", f.Agents[1].Role, "no role: Agent N by its place among the shown")
	for _, a := range f.Agents {
		require.NotEqual(t, "QA Engineer", a.Role)
		require.NotEqual(t, "qa", a.Role, "a hidden agent's role is not shown")
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
	require.Contains(t, string(raw), "backend finished the page", "a real name becomes the public label")
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
		if !p.W {
			shown++
		}
	}
	require.Equal(t, 3, shown, "14 posts, a hit at 7: 5 before and 5 after are withheld, so 0, 1 and 13 stay")
	require.Equal(t, "plain note 0", f.Posts[0].Text)
	require.Equal(t, "plain note 1", f.Posts[1].Text)
	require.True(t, f.Posts[2].W, "5 before the hit are withheld")
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
		if p.W {
			markers++
			require.Equal(t, Post{W: true}, p, "a withheld post is {w:true} and nothing else")
		}
	}
	require.Equal(t, 1, markers, "a run of withheld posts is one marker, so a count does not leak")
}

type errRedactor struct{ redact.Redactor }

func (errRedactor) Text([]byte) ([]byte, error) { return nil, errors.New("rules failed") }

func TestScanErrorWithholdsEverythingFailClosed(t *testing.T) {
	f := Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Backend Dev", "hello", 1)}}, Options{}, errRedactor{hubScan()})
	require.Len(t, f.Posts, 1)
	require.True(t, f.Posts[0].W)
	require.Empty(t, f.Agents[0].Task, "a task title that cannot be judged is dropped")
	f = Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Backend Dev", "hello", 1)}}, Options{}, redact.Refuse)
	require.True(t, f.Posts[0].W, "the refusing redactor withholds too")
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

// Security's MUST 1 on slice 1: a character whose lower case has another length (İ, Ⱥ) before a name must not shift the cut and leak the name or panic.
func TestUnusualCaseCharactersBeforeANameDoNotLeakIt(t *testing.T) {
	for _, pre := range []string{"İ", "İİİ", "Ⱥ", "ȺȺ İ", "ẞ"} {
		in := Input{Agents: twoAgents(), Posts: []PostFacts{
			post("Backend Dev", pre+" thanks Backend Dev and BACKEND dev, also @Ada Lovelace", 1),
			post("Backend Dev", pre+"qa engineer is here", 2), // a hidden agent's name, any case
		}}
		require.NotPanics(t, func() {
			f := Build(in, Options{}, hubScan())
			raw, _ := json.Marshal(f)
			low := strings.ToLower(string(raw))
			for _, bad := range []string{"backend dev", "ada lovelace", "qa engineer"} {
				require.NotContains(t, low, bad, "pre=%q", pre)
			}
		})
	}
}

// MUST 2: the task title takes the same name rule as a post.
func TestTaskTitleNamesAreReplacedOrDropped(t *testing.T) {
	ag := twoAgents()
	ag[0].TaskTitle = "Help Ada Lovelace with the page"
	ag[1].TaskTitle = "Ask QA Engineer to retest"
	f := Build(Input{Agents: ag}, Options{}, hubScan())
	require.Equal(t, "Help Agent 2 with the page", f.Agents[0].Task, "a shown agent's name in a title becomes its role")
	require.Empty(t, f.Agents[1].Task, "a title that names a hidden agent is dropped")
	ag[0].TaskTitle = "Tell @nobody-we-know about it"
	require.Empty(t, Build(Input{Agents: ag}, Options{}, hubScan()).Agents[0].Task, "an unknown @mention drops the title")
}

// SHOULD 1 and 2: the status is one of four words; a role is scanned like any text.
func TestStatusIsOneOfFourWordsAndRoleIsScanned(t *testing.T) {
	ag := twoAgents()
	ag[0].Status = Status("working on /Users/someone/secret")
	ag[0].Role = "api_key=" + "sk_live_" + strings.Repeat("a1B2", 6)
	f := Build(Input{Agents: ag}, Options{}, hubScan())
	require.Equal(t, "idle", f.Agents[0].Status)
	require.Equal(t, "Agent 1", f.Agents[0].Role, "a role with a secret is not shown")
	raw, _ := json.Marshal(f)
	require.NotContains(t, string(raw), "sk_live_")
}

// QA Engineer's items on slice 1 (#21026): split names, role closed like text, short names on word boundaries.
func TestNamesSplitByWhiteSpaceAreStillNames(t *testing.T) {
	for _, split := range []string{"Backend  Dev", "Backend\nDev", "Backend Dev", "backend \t dev", "BACKEND DEV"} {
		f := Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Ada Lovelace", "thanks "+split+" for it", 1)}}, Options{}, hubScan())
		raw, _ := json.Marshal(f)
		require.NotContains(t, strings.ToLower(string(raw)), "dev", "split=%q", split)
		require.Equal(t, "thanks backend for it", f.Posts[0].Text, "split=%q", split)
	}
	hidden := Build(Input{Agents: twoAgents(), Posts: []PostFacts{post("Ada Lovelace", "ask QA  Engineer", 1)}}, Options{}, hubScan())
	require.True(t, hidden.Posts[0].W, "a hidden agent's name split by spaces withholds the post")
}

func TestARoleThatNamesSomeoneIsNotShown(t *testing.T) {
	ag := twoAgents()
	ag[0].Role = "Ada Lovelace's helper"
	f := Build(Input{Agents: ag}, Options{}, hubScan())
	require.Equal(t, "Agent 1", f.Agents[0].Role)
	ag[0].Role = "see coral://artifacts/abc"
	require.Equal(t, "Agent 1", Build(Input{Agents: ag}, Options{}, hubScan()).Agents[0].Role, "an id in a role is not shown")
}

func TestShortNamesAreMatchedOnWordBoundariesOnly(t *testing.T) {
	ag := []AgentFacts{{RealName: "Al", Role: "lead", Status: StatusIdle, Shown: true}, {RealName: "Bo", Role: "qa", Status: StatusIdle, Shown: false}}
	f := Build(Input{Agents: ag, Posts: []PostFacts{post("Al", "Al also thanks Alexander and Al.", 1), post("Al", "a bold move", 2)}}, Options{}, hubScan())
	require.Equal(t, "lead also thanks Alexander and lead.", f.Posts[0].Text, "'also' and 'Alexander' are not garbled")
	require.False(t, f.Posts[1].W, "a hidden short name inside 'bold' is not a mention")
}
