package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/jsonl"
)

// #12138 part 2: the chat half. An agent's newest chat reply that waits on the Operator and is not in their Needs you is the same line and nudge as a board post, and QA Reviewer 2's exclusions are pinned.

func chatSID(n int) string { return fmt.Sprintf("%08d-0000-0000-0000-000000000000", n) }

func (h *checkHarness) chat(said map[string]jsonl.LastMessage) {
	h.m.lastMessage = func(sid, _, _ string) (jsonl.LastMessage, bool) { m, ok := said[sid]; return m, ok }
}

func reply(role, text string, at time.Time) jsonl.LastMessage {
	return jsonl.LastMessage{Role: role, Text: text, At: at.UTC().Format(time.RFC3339Nano)}
}

func TestAChatReplyThatWaitsOnTheOperatorIsALineAndANudge(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	for i, n := range []string{"Orchestrator", "Dev", "QA", "Dev2", "Young", "Old", "Said", "Quiet", "Orch2"} {
		role := "Developer"
		if n == "Orchestrator" {
			role = "Orchestrator"
		}
		h.member(n, role, i+1, 0)
	}
	h.settings(func(hs *board.HealthSettings) { hs.BusyNoTask.On = false })
	_, err := h.s.PostMessage(ctx, "team", "Dev", "marks the board", nil)
	require.NoError(t, err)
	h.checkTo("Orchestrator") // the first scan only marks where the board is

	before := time.Now().UTC().Add(-time.Second)
	hex := strings.Repeat("cd", 32)
	_, err = h.s.AddArtifactTags(ctx, "team", hex, []string{"for review"})
	require.NoError(t, err)
	said := map[string]jsonl.LastMessage{
		chatSID(2): reply("assistant", "I need a decision. @Operator, which of the two?", before),                  // listed
		chatSID(3): reply("assistant", "your call, operator: A or B?", before),                                     // covered by the --ask below
		chatSID(4): reply("assistant", "needs the operator to decide; the file is coral://artifacts/"+hex, before), // covered by its "for review" post below
		chatSID(5): reply("assistant", "@Operator quick one", h.now.Add(5*time.Minute)),                            // younger than the grace once the check runs
		chatSID(6): reply("assistant", "@Operator an old one", h.now.Add(-2*time.Hour)),                            // older than an hour: not new
		chatSID(7): reply("user", "@Operator what the person typed", before),                                       // the person's words, not the agent's
		chatSID(8): reply("assistant", "done, nothing to decide", before),                                          // waits on no one
		chatSID(1): reply("assistant", "@Operator the tag is yours", before),                                       // the orchestrator: a line, no nudge to itself
	}
	h.chat(said)
	m, err := h.s.PostMessage(ctx, "team", "QA", "@Operator which of the two? (as an ask)", nil)
	require.NoError(t, err)
	require.NoError(t, h.s.RecordAsk(ctx, "team", m, []string{"Operator"}))
	_, err = h.s.PostMessage(ctx, "team", "Dev2", "see coral://artifacts/"+hex, nil)
	require.NoError(t, err)

	out := h.next()
	assert.Contains(t, out, "Dev: said something in its chat that waits on the Operator")
	assert.Contains(t, out, "Orchestrator: said something in its chat that waits on the Operator")
	assert.Equal(t, 2, strings.Count(out, "in its chat that waits on the Operator"), "exactly those two: "+out)
	for _, no := range []string{"QA: said", "Dev2: said", "Young: said", "Old: said", "Said: said", "Quiet: said"} {
		assert.NotContains(t, out, no)
	}
	assert.NotContains(t, out, "which of the two", "the reply's words are never in the line")

	h.mu.Lock()
	devSent, orchSent := h.sent["Dev"], h.sent["Orchestrator"]
	h.mu.Unlock()
	nudges := 0
	for _, s := range devSent {
		if strings.Contains(s, "Your last chat reply waits on the Operator") {
			nudges++
			assert.Contains(t, s, "--ask")
			assert.NotContains(t, s, "which of the two", "the nudge quotes nothing")
		}
	}
	assert.Equal(t, 1, nudges, "Dev's reply is nudged once")
	for _, s := range orchSent {
		assert.NotContains(t, s, "Your last chat reply", "the orchestrator is not nudged about its own reply")
	}

	// said once per reply
	h.mu.Lock()
	n0 := len(h.sent["Orchestrator"])
	h.mu.Unlock()
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(ctx)
	h.mu.Lock()
	var later string
	for _, text := range h.sent["Orchestrator"][n0:] {
		later += text
	}
	h.mu.Unlock()
	assert.NotContains(t, later, "Dev: said something", "once per reply")
	assert.NotContains(t, later, "Orchestrator: said something", "once per reply")
	assert.Contains(t, later, "Young: said something", "the younger reply is judged by the check that finds it old enough")
	h.mu.Lock()
	devNudges := 0
	for _, s := range h.sent["Dev"] {
		if strings.Contains(s, "Your last chat reply waits on the Operator") {
			devNudges++
		}
	}
	h.mu.Unlock()
	assert.Equal(t, 1, devNudges, "and Dev is not nudged again for the same reply")
}

// QA Reviewer 2's SHOULD: a Coral Hub user's post, a Coral system post and the Operator's own post that say @Operator are each no line. Each sender is named as a MEMBER here, so the exclusion itself is what keeps it out
// (a sender who is no member is out by that rule alone).
func postsOf(t *testing.T, kind string) func(h *checkHarness) {
	return func(h *checkHarness) {
		ctx := context.Background()
		var err error
		switch kind {
		case "hub":
			_, err = h.s.PostHubMessage(ctx, "team", "Dev", "@Operator which of the two?", nil, false) // a Hub user whose name is a member's
		case "system":
			_, err = h.s.PostSystemMessage(ctx, "team", "Dev", "@Operator which of the two?", nil) // a Coral post under a member's name
		case "operator":
			_, err = h.s.PostMessage(ctx, "team", "Operator", "@Operator which of the two?", nil)
		}
		require.NoError(t, err)
	}
}

func TestAHubUserASystemPostAndTheOperatorsOwnPostThatSayOperatorAreNoLine(t *testing.T) {
	for _, kind := range []string{"hub", "system", "operator"} {
		t.Run(kind, func(t *testing.T) {
			h := newCheckHarness(t)
			ctx := context.Background()
			h.member("Orchestrator", "Orchestrator", 1, 0)
			h.member("Dev", "Developer", 2, 0)
			h.member("Operator", "Operator", 3, 0)
			h.settings(func(hs *board.HealthSettings) { hs.BusyNoTask.On = false })
			_, err := h.s.PostMessage(ctx, "team", "Dev", "marks the board", nil)
			require.NoError(t, err)
			h.checkTo("Orchestrator")

			postsOf(t, kind)(h)

			out := h.next()
			assert.NotContains(t, out, "waits on the Operator", kind+": no line: "+out)
		})
	}
}
