package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8968: a commit is one however many hashes and sessions saw it; each commit lists its sessions in the order they recorded it.
func TestEfficiencyCommitsAreOneAcrossRebasesAndCheckouts(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	gs := NewGitStore(db)
	ss := NewSessionStore(db)
	now := time.Now().UTC()
	at := now.Add(-time.Hour).Format(time.RFC3339)
	other := now.Add(-2 * time.Hour).Format(time.RFC3339)
	snap := func(sid, hash, subject, ts string) {
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &GitSnapshot{AgentName: sid, AgentType: "claude", WorkingDirectory: "/w", Branch: "b", CommitHash: hash, CommitSubject: subject, CommitTimestamp: &ts, SessionID: &sid}))
	}
	snap("s1", "h1", "Fix it", at)
	snap("s2", "h1", "Fix it", at)    // the same hash in another checkout: the same commit
	snap("s1", "h2", "Fix it", at)    // a rebase: new hash, same subject and author time
	snap("s1", "h3", "Fix it", other) // the same subject at another time is another commit
	snap("s1", "h4", "", at)          // no subject: only its own hash identifies it
	got, err := ss.EfficiencyCommits(ctx, now.Add(-24*time.Hour), now)
	require.NoError(t, err)
	require.Len(t, got, 3)
	assert.Equal(t, "h1", got[0].Hash, "the first hash recorded names it")
	require.Len(t, got[0].Seen, 2)
	assert.Equal(t, "s1", got[0].Seen[0].SessionID)
	assert.Equal(t, "s2", got[0].Seen[1].SessionID, "in the order recorded")
}

// #8968: a session's start is the earliest of what is known of it, and its provider comes from whichever row names it.
func TestSessionFactsReadEndedSessionsToo(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	ts := NewTokenUsageStore(db)
	started := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	require.NoError(t, ts.RecordUsage(ctx, &TokenUsage{SessionID: "gone", AgentName: "g", AgentType: "codex", InputTokens: 1, TotalTokens: 1, Source: "jsonl",
		SessionStartAt: started.Format(ISOFormat), RecordedAt: time.Now().UTC().Add(-2 * time.Hour).Format(ISOFormat)}))
	facts, err := NewSessionStore(db).SessionFacts(ctx, []string{"gone", "unknown"})
	require.NoError(t, err)
	assert.True(t, facts["gone"].Start.Equal(started), "%v", facts["gone"].Start)
	assert.Equal(t, "codex", facts["gone"].Provider)
	assert.True(t, facts["unknown"].Start.IsZero())
	assert.Equal(t, "", facts["unknown"].Provider)
}
