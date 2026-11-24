package live

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/pkg/redact"
)

// Coral Live chat (#21094): the chosen agent's replies and a person's typed words, cut, named, scanned and bound to the session they came from.

func chatRows(n int) []ChatRow {
	var out []ChatRow
	for i := 0; i < n; i++ {
		from := "agent"
		if i%2 == 0 {
			from = "person"
		}
		out = append(out, ChatRow{From: from, Text: fmt.Sprintf("message %02d", i), At: time.Unix(int64(1700000000+i), 0)})
	}
	return out
}

func chatAgents(chat []ChatRow) []AgentFacts {
	return []AgentFacts{
		{RealName: "Backend Dev", Role: "backend", Status: StatusWorking, Shown: true, Chat: chat},
		{RealName: "Ada Lovelace", Role: "ux", Status: StatusIdle, Shown: true},
	}
}

func TestChatIsThePersonsAndTheAgentsWordsInOrderWithAFixedPairOfSenders(t *testing.T) {
	f := Build(Input{Agents: chatAgents(chatRows(3))}, Options{}, hubScan())
	require.Len(t, f.Agents[0].Chat, 3)
	assert.Equal(t, Chat{From: "person", Text: "message 00", At: 1700000000}, f.Agents[0].Chat[0])
	assert.Equal(t, "agent", f.Agents[0].Chat[1].From)
	assert.Empty(t, f.Agents[1].Chat, "chat is on the chosen agent only")
	raw, _ := json.Marshal(f)
	assert.NotContains(t, string(raw), `"chat":null`)
}

func TestChatShowsTheLastTwelveAndEachMessageIsCutAtFiveHundred(t *testing.T) {
	rows := chatRows(15)
	rows[14].Text = strings.Repeat("a", 900)
	f := Build(Input{Agents: chatAgents(rows)}, Options{}, hubScan())
	c := f.Agents[0].Chat
	require.Len(t, c, 12)
	assert.Equal(t, "message 03", c[0].Text, "the newest 12 of 15")
	assert.Len(t, []rune(c[11].Text), 500)
	raw, _ := json.Marshal(f)
	assert.Less(t, len(raw), 64<<10, "twelve long messages fit a frame")
}

func TestChatNamesAndPathsFollowTheSameRulesAsPosts(t *testing.T) {
	rows := []ChatRow{
		{From: "person", Text: "ask Ada Lovelace to look", At: time.Unix(1700000001, 0)},
		{From: "agent", Text: "I changed /Users/someone/project/main.go", At: time.Unix(1700000002, 0)},
		{From: "agent", Text: "see coral://artifacts/abc123 for details", At: time.Unix(1700000003, 0)},
		{From: "agent", Text: "pinging @Nobody Known", At: time.Unix(1700000004, 0)},
	}
	f := Build(Input{Agents: chatAgents(rows)}, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	s := string(raw)
	assert.NotContains(t, s, "Ada Lovelace", "a real name is its public label")
	assert.NotContains(t, s, "/Users/")
	assert.NotContains(t, s, "coral://")
	assert.NotContains(t, s, "Nobody")
	c := f.Agents[0].Chat
	require.NotEmpty(t, c)
	assert.Equal(t, "ask ux to look", c[0].Text, "the name is the agent's public label")
	assert.True(t, c[1].W, "a path withholds the message")
}

func TestASecretInChatWithholdsTheMessageAndFiveOnEachSide(t *testing.T) {
	rows := chatRows(12)
	rows[5].Text = "token: " + "ghp_" + strings.Repeat("x9Y8", 9)
	f := Build(Input{Agents: chatAgents(rows)}, Options{}, hubScan())
	c := f.Agents[0].Chat
	raw, _ := json.Marshal(f)
	assert.NotContains(t, string(raw), "x9Y8x9Y8")
	require.Len(t, c, 2, "messages 0 to 10 are one marker (the hit, 5 before and 5 after) and only message 11 stands")
	assert.True(t, c[0].W)
	assert.Equal(t, "message 11", c[1].Text)
}

func TestASecretCutAcrossTwoChatMessagesIsWithheld(t *testing.T) {
	rows := chatRows(12)
	tok := "ghp_" + strings.Repeat("x9Y8", 9)
	rows[2].Text = "token: " + tok[:20]
	rows[3].Text = tok[20:] + " and ends here"
	f := Build(Input{Agents: chatAgents(rows)}, Options{}, hubScan())
	raw, _ := json.Marshal(f)
	assert.NotContains(t, string(raw), tok[:20])
	assert.NotContains(t, string(raw), tok[20:])
}

func TestAFailingRedactorWithholdsEveryChatMessage(t *testing.T) {
	f := Build(Input{Agents: chatAgents(chatRows(4))}, Options{}, redact.Refuse)
	require.Len(t, f.Agents[0].Chat, 1)
	assert.True(t, f.Agents[0].Chat[0].W)
	assert.Empty(t, f.Agents[0].Chat[0].Text)
}

// Chat for a hidden agent, and for any agent but the one picked, is never in the input.
type chatSrc struct {
	fakeSource
	calls []string
	err   error
}

func (c *chatSrc) Chat(_ context.Context, key, gen string, n int) ([]ChatRow, error) {
	c.calls = append(c.calls, key+"/"+gen)
	if c.err != nil {
		return nil, c.err
	}
	return chatRows(n), nil
}

func TestChatIsReadOnlyForThePickedShownAgentAndAChangedGenerationIsNoChat(t *testing.T) {
	src := &chatSrc{fakeSource: fakeSource{agents: rows()}}
	in, err := Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"s1": true, "s4": true}, ChatKey: "s1", ChatGen: "g1"})
	require.NoError(t, err)
	assert.Equal(t, []string{"s1/g1"}, src.calls, "only the picked agent's chat is asked for")
	assert.Len(t, in.Agents[0].Chat, 12)
	assert.Empty(t, in.Agents[3].Chat)

	src = &chatSrc{fakeSource: fakeSource{agents: rows()}}
	_, err = Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"s2": true}, ChatKey: "s1", ChatGen: "g1"})
	require.NoError(t, err)
	assert.Empty(t, src.calls, "a picked agent that is not shown has no chat read")

	src = &chatSrc{fakeSource: fakeSource{agents: rows()}, err: ErrGenChanged}
	in, err = Gather(context.Background(), src, ViewChoice{Shown: map[string]bool{"s1": true}, ChatKey: "s1", ChatGen: "g1"})
	require.NoError(t, err, "a changed generation does not fail the frame")
	assert.Empty(t, in.Agents[0].Chat)
}

// MUST B proof (Security's open item): a resume, a restart, a wake and a reused name each change the generation, so the old chat is not read under the new session.
func TestAResumeARestartAWakeAndAReusedNameEachChangeTheGenerationAndOldChatIsNotRead(t *testing.T) {
	ctx := context.Background()
	st, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	const sidA = "11111111-0000-4000-8000-00000000000a"
	_, err = st.Subscribe(ctx, "team", "Backend Dev", "backend", "claude-"+sidA, nil, "all")
	require.NoError(t, err)

	facts := map[string]SessionFacts{
		"claude-" + sidA: {ID: sidA, Type: "claude", WorkingDir: "/w", Created: "2026-11-24T10:00:00Z", Launched: "2026-11-24T10:00:00Z"},
	}
	reads := 0
	src := NewBoardSource(st, "team", nil).WithChat(
		func(_ context.Context, name string) (SessionFacts, bool) { f, ok := facts[name]; return f, ok },
		func(SessionFacts, int) ([]ChatRow, bool) { reads++; return chatRows(2), true })
	genNow := func() string {
		rs, err := src.Agents(ctx)
		require.NoError(t, err)
		for _, r := range rs {
			if r.Key == "Backend Dev" {
				return r.Generation
			}
		}
		return ""
	}
	g0 := genNow()
	require.NotEmpty(t, g0)
	assert.Equal(t, g0, genNow(), "nothing changed: the same generation")
	rows, err := src.Chat(ctx, "Backend Dev", g0, 12)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	reads = 0

	seen := map[string]string{g0: "start"}
	check := func(what string) {
		g := genNow()
		require.NotEmpty(t, g, what)
		_, dup := seen[g]
		assert.False(t, dup, "%s: the generation must differ from every earlier one (%s)", what, seen[g])
		seen[g] = what
		_, err := src.Chat(ctx, "Backend Dev", g0, 12)
		assert.ErrorIs(t, err, ErrGenChanged, "%s: the old chat is not read", what)
		assert.Zero(t, reads, "%s: the transcript was not even opened", what)
	}

	// a wake: the same row, its launch line typed again
	f := facts["claude-"+sidA]
	f.Launched = "2026-11-24T11:00:00Z"
	facts["claude-"+sidA] = f
	check("wake")

	// a restart (and a resume): the store makes a new session row, so a new id and time; the agent takes its role over
	const sidB = "22222222-0000-4000-8000-00000000000b"
	_, err = st.Subscribe(ctx, "team", "Backend Dev", "backend", "claude-"+sidB, nil, "all")
	require.NoError(t, err)
	facts["claude-"+sidB] = SessionFacts{ID: sidB, Type: "claude", Created: "2026-11-24T12:00:00Z", Launched: "2026-11-24T12:00:00Z"}
	check("restart or resume into a new session")

	// a resume that reuses the CLI's own session id but is a new row (the store's created time moves)
	f = facts["claude-"+sidB]
	f.Created = "2026-11-24T13:00:00Z" // only the row's created time moves
	facts["claude-"+sidB] = f
	check("a resumed row of the same session id")

	// the agent leaves and its name is reused by another session
	_, err = st.Unsubscribe(ctx, "team", "Backend Dev")
	require.NoError(t, err)
	const sidC = "33333333-0000-4000-8000-00000000000c"
	_, err = st.Subscribe(ctx, "team", "Backend Dev", "backend", "claude-"+sidC, nil, "all")
	require.NoError(t, err)
	facts["claude-"+sidC] = SessionFacts{ID: sidC, Type: "claude", Created: "2026-11-24T14:00:00Z", Launched: "2026-11-24T14:00:00Z"}
	check("a reused name")

	// the CLI changes under the same name
	f = facts["claude-"+sidC]
	f.Type = "codex"
	facts["claude-"+sidC] = f
	check("another CLI")

	// the session is gone: no generation, no chat
	delete(facts, "claude-"+sidC)
	assert.Empty(t, genNow())
	_, err = src.Chat(ctx, "Backend Dev", g0, 12)
	assert.ErrorIs(t, err, ErrGenChanged)
}

func TestWithoutASessionLookupNoAgentHasAGenerationOrChat(t *testing.T) {
	ctx := context.Background()
	st, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	_, err = st.Subscribe(ctx, "team", "Backend Dev", "backend", "claude-11111111-0000-4000-8000-00000000000a", nil, "all")
	require.NoError(t, err)
	src := NewBoardSource(st, "team", nil)
	rs, err := src.Agents(ctx)
	require.NoError(t, err)
	require.Len(t, rs, 1)
	assert.Empty(t, rs[0].Generation)
	_, err = src.Chat(ctx, "Backend Dev", "anything", 12)
	assert.ErrorIs(t, err, ErrGenChanged)
}

// A frame built after the generation changed, before the next Tick turns the pick off, has no chat at all.
func TestAFrameBuiltAfterARestartHasNoChatEvenBeforeTheNextTick(t *testing.T) {
	m, src, _, _ := fixture(t)
	ctx := context.Background()
	cs := &genChatSrc{mutSource: src}
	m.cfg.Source = func(string) LiveSource { return cs }
	_, _ = m.Create(hubA, "team", "Operator", testVia)
	_, err := m.SetViews(ctx, "L1", Views{ChatKey: "backend"})
	require.NoError(t, err)
	p, _ := m.Preview(ctx, "L1")
	require.NotEmpty(t, previewChat(p.Frame), "the preview shows the real chat")
	_, err = m.GoLive(ctx, "L1", p.Hash, true)
	require.NoError(t, err)
	f, err := m.Frame(ctx, "L1", 1)
	require.NoError(t, err)
	require.NotEmpty(t, previewChat(f))

	src.rows[0].Generation = "s1@t2" // the agent restarted; no Tick has run
	f, err = m.Frame(ctx, "L1", 2)
	require.NoError(t, err)
	assert.Empty(t, previewChat(f), "old chat never shows under a new session")
}

type genChatSrc struct{ *mutSource }

func (g *genChatSrc) Chat(_ context.Context, key, gen string, n int) ([]ChatRow, error) {
	for _, r := range g.rows {
		if r.Key == key && r.Generation == gen {
			return chatRows(2), nil
		}
	}
	return nil, ErrGenChanged
}

func previewChat(f Frame) []Chat {
	for _, a := range f.Agents {
		if len(a.Chat) > 0 {
			return a.Chat
		}
	}
	return nil
}
