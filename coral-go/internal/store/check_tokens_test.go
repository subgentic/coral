package store

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newCheckTokenDB(t *testing.T) *DB { return openTestDB(t) }

func TestACheckTokenIsForOneRunAndEndsWithIt(t *testing.T) {
	db, ctx, now := newCheckTokenDB(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	sp := CheckTokenSpec{SessionID: "s1", SessionName: "claude-s1", Project: "team", Check: "prs", TTL: 30 * time.Second}
	tok, err := db.MintCheckToken(ctx, sp, now)
	require.NoError(t, err)
	assert.Contains(t, tok, "ck1.")
	o, err := db.CheckTokenOf(ctx, tok, now.Add(10*time.Second))
	require.NoError(t, err)
	assert.Equal(t, "claude-s1", o.SessionName)
	assert.False(t, o.MayWrite, "read-only unless the record says it may write")
	_, err = db.CheckTokenOf(ctx, tok, now.Add(31*time.Second))
	assert.ErrorIs(t, err, ErrUnknownCheckToken, "expired with its run")
	_, err = db.CheckTokenOf(ctx, "ck1.nope", now)
	assert.ErrorIs(t, err, ErrUnknownCheckToken)
	_, err = db.MintCheckToken(ctx, CheckTokenSpec{SessionName: "x", Project: "p", Check: "c"}, now)
	assert.Error(t, err, "a token with no lifetime is refused")

	require.NoError(t, db.RevokeCheckToken(ctx, tok, now))
	_, err = db.CheckTokenOf(ctx, tok, now)
	assert.ErrorIs(t, err, ErrUnknownCheckToken, "revoked at once, no cache")
}

func TestRevokingOneChecksTokensLeavesOthers(t *testing.T) {
	db, ctx, now := newCheckTokenDB(t), context.Background(), time.Now()
	a, _ := db.MintCheckToken(ctx, CheckTokenSpec{SessionID: "s", SessionName: "claude-s", Project: "team", Check: "a", TTL: time.Minute}, now)
	b, _ := db.MintCheckToken(ctx, CheckTokenSpec{SessionID: "s", SessionName: "claude-s", Project: "team", Check: "b", TTL: time.Minute}, now)
	require.NoError(t, db.RevokeCheckTokensFor(ctx, "team", "a", now))
	_, err := db.CheckTokenOf(ctx, a, now)
	assert.Error(t, err)
	_, err = db.CheckTokenOf(ctx, b, now)
	assert.NoError(t, err)
	require.NoError(t, db.RevokeAllCheckTokens(ctx, now))
	_, err = db.CheckTokenOf(ctx, b, now)
	assert.Error(t, err)
}

func TestACheckTokenDoesNotTouchTheMembersOwnToken(t *testing.T) {
	db, ctx, now := newCheckTokenDB(t), context.Background(), time.Now()
	own, err := db.MintSessionToken(ctx, "s1", "claude-s1")
	require.NoError(t, err)
	_, err = db.MintCheckToken(ctx, CheckTokenSpec{SessionID: "s1", SessionName: "claude-s1", Project: "team", Check: "a", TTL: time.Minute}, now)
	require.NoError(t, err)
	_, err = db.SessionTokenOwnerOf(ctx, own)
	assert.NoError(t, err, "the member's session token still works")
	tok, _ := db.MintCheckToken(ctx, CheckTokenSpec{SessionID: "s1", SessionName: "claude-s1", Project: "team", Check: "a", TTL: time.Minute}, now)
	_, err = db.SessionTokenOwnerOf(ctx, tok)
	assert.Error(t, err, "a check token is not a session token")
}

func TestWritesAreCappedPerRunAndPerHourPerCheck(t *testing.T) {
	db, ctx, now := newCheckTokenDB(t), context.Background(), time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	mint := func() string {
		tok, err := db.MintCheckToken(ctx, CheckTokenSpec{SessionID: "s", SessionName: "claude-s", Project: "team", Check: "w", MayWrite: true, TTL: time.Minute}, now)
		require.NoError(t, err)
		return tok
	}
	t1 := mint()
	for i := 0; i < CheckWritesPerRun; i++ {
		ok, err := db.TakeCheckWrite(ctx, t1, now)
		require.NoError(t, err)
		assert.True(t, ok, i)
	}
	ok, _ := db.TakeCheckWrite(ctx, t1, now)
	assert.False(t, ok, "5 a run")
	t2 := mint()
	ok, _ = db.TakeCheckWrite(ctx, t2, now)
	assert.True(t, ok, "the 6th of the hour")
	ok, _ = db.TakeCheckWrite(ctx, t2, now)
	assert.False(t, ok, "6 an hour for the check, across runs")
	ok, _ = db.TakeCheckWrite(ctx, t2, now.Add(61*time.Second))
	assert.False(t, ok, "the token had expired")
}
