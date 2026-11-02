package background

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #12138 (the Operator): the check flags a post that waits on the Operator and is not in their Needs you (no --ask to them and no "for review" file linked within ten minutes), and nudges its author.
func TestAPostThatWaitsOnTheOperatorAndIsNotInNeedsYouIsALineAndANudge(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("QA", "QA Engineer", 3, 0)
	h.member("Dev2", "Developer", 4, 0)
	h.member("Late", "Developer", 5, 0)
	h.settings(func(hs *board.HealthSettings) { hs.BusyNoTask.On = false }) // the harness agents are in a turn: that signal's lines are not what this test is about
	post := func(who, text string) *board.Message {
		t.Helper()
		m, err := h.s.PostMessage(ctx, "team", who, text, nil)
		require.NoError(t, err)
		return m
	}
	ask := func(who, text string) {
		t.Helper()
		m := post(who, text)
		require.NoError(t, h.s.RecordAsk(ctx, "team", m, []string{"Operator"}))
	}
	post("Dev", "before the first scan: @Operator pick one") // the first scan only marks where the board is
	h.checkTo("Orchestrator")

	post("Dev", "@Operator please pick A or B")          // listed: no ask, no file
	post("QA", "@Operator which of the two?")            // covered by the --ask right after
	ask("QA", "@Operator which of the two? (as an ask)") //
	ask("Dev2", "@Operator need your choice")            // the post is itself an --ask
	hex := strings.Repeat("ab", 32)
	_, err0 := h.s.AddArtifactTags(ctx, "team", hex, []string{"for review"})
	require.NoError(t, err0)
	post("Dev2", "needs the operator to decide, the file is coral://artifacts/"+hex) // covered: a "for review" file is linked
	post("Dev2", "the operator decides this one")                                    // listed: no ask, and the file linked above is another post
	post("Dev", "your call between the two of us")                                   // not the Operator's: no word "operator"
	post("Dev", "say if you want me to go on")                                       // no word "operator"
	post("Late", "say if you want it, operator")                                     // listed: a phrase and the word
	post("Orchestrator", "@Operator the release is yours to tag")                    // the orchestrator is the one told: a line, no nudge to itself
	post("Operator", "@Operator test")                                               // the Operator's own post
	_, err := h.s.PostSystemMessage(ctx, "team", "Coral Task Queue", "@Operator system", nil)
	require.NoError(t, err)
	post("Ghost", "@Operator not a member")

	out := h.next()
	assert.Contains(t, out, "Dev: posted something that waits on the Operator")
	assert.Contains(t, out, "Dev2: posted something that waits on the Operator")
	assert.Contains(t, out, "Late: posted something that waits on the Operator")
	assert.Contains(t, out, "Orchestrator: posted something that waits on the Operator")
	assert.Equal(t, 4, strings.Count(out, "waits on the Operator (message #"), "exactly those four: "+out)
	assert.NotContains(t, out, "QA: posted something")
	assert.NotContains(t, out, "pick A or B", "the post's words are never in the line")

	h.mu.Lock()
	devSent, orchSent := h.sent["Dev"], h.sent["Orchestrator"]
	h.mu.Unlock()
	nudges := 0
	for _, s := range devSent {
		if strings.Contains(s, "waits on the Operator, but it is not in their Needs you") {
			nudges++
			assert.Contains(t, s, "--ask")
			assert.NotContains(t, s, "pick A or B", "the nudge quotes nothing")
		}
	}
	assert.Equal(t, 1, nudges, "Dev's one post is nudged once")
	for _, s := range orchSent {
		assert.NotContains(t, s, "Your board message", "the orchestrator is not nudged about its own post")
	}

	// said once per message: the next checks do not repeat them
	h.mu.Lock()
	before := len(h.sent["Orchestrator"])
	h.mu.Unlock()
	h.now = h.now.Add(11 * time.Minute)
	h.m.scan(context.Background())
	h.mu.Lock()
	for _, text := range h.sent["Orchestrator"][before:] {
		assert.NotContains(t, text, "waits on the Operator (message #", "said once per message")
	}
	h.mu.Unlock()
}

func TestWaitsOnOperatorReadsMentionsAndPhrasesWithTheWord(t *testing.T) {
	for _, yes := range []string{"@Operator please decide", "ok @operator?", "the Operator decides", "needs the operator", "waiting on the Operator for a go", "Say if you want, Operator", "operator: your call"} {
		assert.True(t, board.WaitsOnOperator(yes), yes)
	}
	for _, no := range []string{"your call", "say if you want", "I told the operator hello", "operators of the pool decide", "an operator-less thing", "decides without anyone", ""} {
		assert.False(t, board.WaitsOnOperator(no), no)
	}
}

// A post younger than the ten minutes is not judged: the author still has the time. It is judged by the scan that finds it old enough, and the scan that stopped at it did not move past it.
func TestAPostYoungerThanTheGraceIsJudgedLater(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	_, err := h.s.PostMessage(ctx, "team", "Dev", "marks the board", nil)
	require.NoError(t, err)
	subs, err := h.s.ListSubscribers(ctx, "team")
	require.NoError(t, err)
	scan := func(at time.Time) {
		t.Helper()
		h.m.noteOperatorWaits(ctx, "team", "Orchestrator", subs, map[string]AgentInfo{}, at)
	}
	pending := func(at time.Time) int {
		t.Helper()
		got, err := h.s.PendingOffBooks(ctx, "team", at, map[string]bool{board.OffBooksOperatorWait: true})
		require.NoError(t, err)
		return len(got)
	}
	posted := time.Now().UTC()
	scan(posted) // the first scan marks where the board is
	_, err = h.s.PostMessage(ctx, "team", "Dev", "@Operator a fresh question", nil)
	require.NoError(t, err)

	scan(posted.Add(5 * time.Minute))
	assert.Zero(t, pending(posted.Add(5*time.Minute)), "five minutes old: not judged")
	scan(posted.Add(9 * time.Minute))
	assert.Zero(t, pending(posted.Add(9*time.Minute)), "nine minutes old: not judged")
	scan(posted.Add(11 * time.Minute))
	assert.Equal(t, 1, pending(posted.Add(11*time.Minute)), "eleven minutes old: judged, and not skipped by the scans before it")
	scan(posted.Add(20 * time.Minute))
	assert.Equal(t, 1, pending(posted.Add(20*time.Minute)), "and said once")
}
