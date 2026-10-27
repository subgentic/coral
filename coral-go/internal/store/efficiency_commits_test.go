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

// #8996: a commit is credited only to a session whose identity it matches; one with no recorded author is anyone's.
func TestACommitIsMadeByTheSessionWhoseIdentityItsAuthorMatches(t *testing.T) {
	IdentityHash := testHasher(t)
	c := EfficiencyCommit{AuthorName: "Backend Dev", AuthorHash: IdentityHash("bd@example.invalid")}
	assert.True(t, c.MadeBy(CommitSighting{AgentName: "backend dev"}, ""), "by the agent's name, in any case")
	assert.True(t, c.MadeBy(CommitSighting{AgentName: "agent-7"}, "Backend Dev"), "by the agent's display name")
	assert.True(t, c.MadeBy(CommitSighting{AgentName: "x", IdentHash: IdentityHash(" BD@example.invalid ")}, ""), "by the email's hash, whatever its case")
	assert.True(t, c.MadeBy(CommitSighting{AgentName: "x", IdentName: "Backend Dev"}, ""), "by the checkout's configured name")
	assert.False(t, c.MadeBy(CommitSighting{AgentName: "Frontend Dev", IdentName: "Operator", IdentHash: IdentityHash("op@example.invalid")}, "Frontend Dev"), "a teammate who pulled it")
	assert.True(t, EfficiencyCommit{}.MadeBy(CommitSighting{AgentName: "Anyone"}, ""), "no recorded author: as before")
	assert.Equal(t, "", IdentityHash("  "))
	assert.Len(t, IdentityHash("a@b"), 16)
}

// testHasher is the real hasher, keyed by a master key made in a temporary data directory.
func testHasher(t *testing.T) IdentityHasher {
	t.Helper()
	return NewIdentityHasher(NewRemoteServerStore(openTestDB(t), t.TempDir()))
}

// #9046: the pseudonym of an email is keyed with the install's master key: stable for one key, different under another, and the address is not in it.
func TestTheIdentityPseudonymIsKeyedByTheInstallsMasterKey(t *testing.T) {
	db := openTestDB(t)
	dirA, dirB := t.TempDir(), t.TempDir()
	a1 := NewIdentityHasher(NewRemoteServerStore(db, dirA))
	a2 := NewIdentityHasher(NewRemoteServerStore(db, dirA)) // another store of the same install
	b := NewIdentityHasher(NewRemoteServerStore(db, dirB))
	h := a1("Backend-Dev@Example.invalid")
	require.Len(t, h, 16)
	assert.Equal(t, h, a2(" backend-dev@example.invalid "), "the same install, whatever the case or spaces")
	assert.NotEqual(t, h, b("backend-dev@example.invalid"), "another install's key: another pseudonym, so a copy of the database cannot be matched against guesses")
	assert.NotContains(t, h, "@")
	assert.Equal(t, "", a1(""))
	assert.Equal(t, "", NewIdentityHasher(nil)("a@b"), "no key store: nothing is stored")
}

// #8999: two commits with the same subject and author second but different authors are two commits; a rebased copy by the same author is one.
func TestEfficiencyCommitCopiesNeedTheSameAuthorToo(t *testing.T) {
	db := openTestDB(t)
	IdentityHash := NewIdentityHasher(NewRemoteServerStore(db, t.TempDir()))
	ctx := context.Background()
	gs := NewGitStore(db)
	now := time.Now().UTC()
	at := now.Add(-time.Hour).Format(time.RFC3339)
	snap := func(sid, hash, author string) {
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &GitSnapshot{AgentName: sid, AgentType: "claude", WorkingDirectory: "/w", Branch: "b", CommitHash: hash, CommitSubject: "WIP", CommitTimestamp: &at, SessionID: &sid,
			AuthorName: author, AuthorHash: IdentityHash(author + "@example.invalid")}))
	}
	snap("s1", "h1", "ann")
	snap("s1", "h2", "ann") // a rebased copy
	snap("s2", "h3", "bob") // another author's commit of the same subject in the same second
	got, err := NewSessionStore(db).EfficiencyCommits(ctx, now.Add(-24*time.Hour), now)
	require.NoError(t, err)
	assert.Len(t, got, 2)
}
