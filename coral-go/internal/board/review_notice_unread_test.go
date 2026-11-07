package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14104 (Technical Writer's first-run walkthrough, #14084): "@<orchestrator> [Task #N in review] ..." is posted by Coral Task Queue, and CheckUnread left every Coral Task Queue message out, so in a quiet
// team (nobody else posted) an Orchestrator waiting in coral-board wait was never nudged: its plain read returns the notice, the count said 0. A busy team hid it, because any other unread message made the
// count non-zero and the read returned the notice too. The notice that NAMES the orchestrator counts; every other queue line (health, reminders, park, assignments, a notice for someone else) stays out.
func TestTheReviewNoticeThatNamesTheOrchestratorIsUnreadButOtherQueueLinesAreNot(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	for name, spec := range map[string][2]string{"Lead": {"Orchestrator", "all"}, "Dev": {"Developer", "all"}} {
		_, err := s.Subscribe(ctx, "team", name, spec[0], "claude-"+name, nil, spec[1])
		require.NoError(t, err)
	}
	queue := func(text string) int64 {
		m, err := s.PostSystemMessage(ctx, "team", "Coral Task Queue", text, nil)
		require.NoError(t, err)
		return m.ID
	}
	unread := func(who string) int { n, err := s.CheckUnread(ctx, "team", who); require.NoError(t, err); return n }
	latest := func(who string) int64 {
		id, err := s.LatestUnreadMessageID(ctx, "team", who)
		require.NoError(t, err)
		return id
	}

	// the lines the queue posts all day stay out of the count: no flood
	queue("[Coral health] stuck: Dev has had no update for 30 minutes")
	queue("[Task #4 reminder] set for 2026-11-07 10:00, sent to Dev")
	queue("[Task #5 parked by Dev] no reminders or nudges for it until then")
	queue("@Dev [Task #6 (high)] Build the thing: assigned to you, run 'coral-board task claim 6'")
	queue("@Other [Task #8 in review] Dev submitted \"X\" (candidate: c; r). Complete it with 'coral-board task complete 8'")
	assert.Zero(t, unread("Lead"), "health, reminders, park, assignments and another member's notice are not unread for the orchestrator")
	assert.Zero(t, unread("Dev"))

	// the review notice that names the orchestrator is
	id := queue("@Lead [Task #7 in review] Dev submitted \"Fix the login\" (candidate: abc123; ready). Complete it with 'coral-board task complete 7', or delegate it: coral-board task review 7 --to \"Security Reviewer\"")
	assert.Equal(t, 1, unread("Lead"), "the notice names the orchestrator: its read returns it, so it is counted and the agent is nudged")
	assert.Equal(t, id, latest("Lead"), "and it is the latest message to nudge about")
	assert.Zero(t, unread("Dev"), "a member it does not name is not nudged")

	// the plain read returns what was counted, and the count is then 0
	msgs, err := s.ReadMessages(ctx, "team", "Lead", 50)
	require.NoError(t, err)
	var seen bool
	for _, m := range msgs {
		if m.ID == id {
			seen = true
		}
	}
	require.True(t, seen, "the plain read returns the notice")
	assert.Zero(t, unread("Lead"))
}
