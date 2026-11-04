package board

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12158: the Inbox-versus-chat counts are counts and nothing else, and each action is on the side the record says.
func TestInboxVsChatCountsEachActionOnItsSideAndLeavesOutWhatItCannotTell(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	rec := func(team, action, surface, hint string) {
		require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "local", Source: "local", Surface: surface, Hint: hint}, action, "file", "x", "x", team))
	}
	rec("alpha", ActApprove, "inbox", "phone")
	rec("alpha", ActApprove, "", "")      // no word from the page: the Activity record is the Inbox's own actions
	rec("alpha", ActDeny, "chat", "")     // the page said the action was taken in a chat
	rec("beta", ActGoalDone, "inbox", "") // another team
	rec("alpha", ActUndone, "inbox", "")  // a rollback is the system's, not the Operator's
	touch := func(team, kind, surface string, daysAgo int) {
		require.NoError(t, s.RecordOperatorTouchOn(ctx, team, "Dev", kind, TouchLocal, surface, now.AddDate(0, 0, -daysAgo)))
	}
	touch("alpha", TouchTyped, "chat", 1)
	touch("alpha", TouchTyped, "", 2)       // typed is chat whatever the row says
	touch("alpha", TouchAnswer, "inbox", 1) // the same route as the chat's prompt: the page said where
	touch("alpha", TouchAnswer, "chat", 1)
	touch("alpha", TouchAnswer, "", 2) // not known: left out of the share
	touch("alpha", TouchWake, "", 1)
	touch("beta", TouchStop, "", 1)
	touch("alpha", TouchApprove, "inbox", 1)

	since, until := now.AddDate(0, 0, -5).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339)
	r, err := s.InboxVsChatCounts(ctx, "", since, until)
	require.NoError(t, err)
	assert.Equal(t, map[string]int{"approve": 2, "goal_close": 1, "answer_prompt": 1}, r.Inbox)
	assert.Equal(t, map[string]int{"deny": 1, "typed": 2, "answer_prompt": 1}, r.Chat)
	assert.Equal(t, map[string]int{"answer_prompt": 1}, r.Unknown, "an answer with no word from the page is not guessed")
	assert.Equal(t, map[string]int{"wake": 1, "stop": 1, "approve": 1}, r.Apart, "managing an agent and approving a task are not in the share")
	assert.Equal(t, 1, r.Phone.Phone)
	assert.Equal(t, 2, r.Phone.Other, "the hint is on the Activity record's rows only: an approval and a goal with no hint (a touch has none)")
	assert.Equal(t, now.Format("2006-01-02"), r.RecordSince)
	assert.Equal(t, InboxVsChatNote, r.Note)
	// per day: the sides add up to the kinds
	inbox, chat, unknown := 0, 0, 0
	for _, d := range r.Days {
		inbox, chat, unknown = inbox+d.Inbox, chat+d.Chat, unknown+d.Unknown
	}
	assert.Equal(t, 4, inbox)
	assert.Equal(t, 4, chat)
	assert.Equal(t, 1, unknown)
	// a team's own counts
	require.Len(t, r.Teams, 2)
	assert.Equal(t, "alpha", r.Teams[0].Team, "the busiest team first")
	rb, err := s.InboxVsChatCounts(ctx, "beta", since, until)
	require.NoError(t, err)
	assert.Equal(t, map[string]int{"goal_close": 1}, rb.Inbox)
	assert.Empty(t, rb.Chat)

	// counts and nothing else: no text, no id, no length anywhere in the answer
	raw, _ := json.Marshal(r)
	for _, never := range []string{"item_id", "version", "title", "note\":\"x", "actor", "hash"} {
		assert.NotContains(t, string(raw), never)
	}
}

func TestInboxVsChatCountsRefuseAWindowPastNinetyDaysAndABackwardOne(t *testing.T) {
	s := activityStore(t)
	now := time.Now().UTC()
	_, err := s.InboxVsChatCounts(context.Background(), "", now.AddDate(0, 0, -91).Format(time.RFC3339), now.Format(time.RFC3339))
	assert.ErrorIs(t, err, ErrBadActivityWindow)
	_, err = s.InboxVsChatCounts(context.Background(), "", now.Format(time.RFC3339), now.AddDate(0, 0, -1).Format(time.RFC3339))
	assert.ErrorIs(t, err, ErrBadActivityWindow)
	_, err = s.InboxVsChatCounts(context.Background(), "", "yesterday", now.Format(time.RFC3339))
	assert.ErrorIs(t, err, ErrBadActivityWindow)
}

func TestInboxVsChatExcludesAutomaticSupersedesButCountsPersonIgnores(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	record := func(team, action, surface, hint string) {
		require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "local", Source: "local", Surface: surface, Hint: hint}, action, "file", "x", "x", team))
	}
	record("alpha", ActIgnore, SurfaceInbox, "phone")
	record("alpha", ActApprove, SurfaceInbox, "")
	record("alpha", ActSupersede, SurfaceInbox, "phone")
	record("alpha", ActSupersede, SurfaceChat, "")
	record("auto-only", ActSupersede, SurfaceInbox, "")
	since, until := now.Add(-time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339)
	got, err := s.InboxVsChatCounts(ctx, "", since, until)
	require.NoError(t, err)
	require.Equal(t, map[string]int{ActIgnore: 1, ActApprove: 1}, got.Inbox)
	require.Empty(t, got.Chat)
	require.Equal(t, 1, got.Phone.Phone)
	require.Equal(t, 1, got.Phone.Other)
	require.Len(t, got.Days, 1)
	require.Equal(t, 2, got.Days[0].Inbox)
	require.Zero(t, got.Days[0].Chat)
	require.Equal(t, []IVCTeam{{Team: "alpha", Inbox: 2}}, got.Teams)
	only, err := s.InboxVsChatCounts(ctx, "auto-only", since, until)
	require.NoError(t, err)
	require.Empty(t, only.Inbox)
	require.Empty(t, only.Chat)
	require.Empty(t, only.Days)
	require.Empty(t, only.Teams)
	// Excluding automated work from this metric must preserve the Activity ledger.
	rows, err := s.ListActivity(ctx, ActivityFilter{Action: ActSupersede})
	require.NoError(t, err)
	require.Len(t, rows, 3)
}
