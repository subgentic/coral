package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14814 reworked: removals from Dropbox after the Operator's delete. Each test names the mutant it fails against.

var removalNow = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

// Mutants: no grace (due at once); a due removal not handed out; a retry not respected; a restart losing the queue (it is a table).
func TestARemovalWaitsOutItsGraceAndItsRetry(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	st, err := ob.QueueRemoval(ctx, rmHex("a"), "notes.md", removalNow, false)
	require.NoError(t, err)
	assert.Equal(t, DropboxRemovalWaiting, st)
	due, err := ob.DueRemovals(ctx, removalNow.Add(DropboxRemovalGrace-time.Minute), 10)
	require.NoError(t, err)
	assert.Empty(t, due, "nothing before the 24-hour grace has passed")
	due, err = ob.DueRemovals(ctx, removalNow.Add(DropboxRemovalGrace), 10)
	require.NoError(t, err)
	require.Len(t, due, 1)
	assert.Equal(t, "notes.md", due[0].Name)
	require.NoError(t, ob.RetryRemoval(ctx, rmHex("a"), removalNow.Add(DropboxRemovalGrace+time.Hour)))
	due, _ = ob.DueRemovals(ctx, removalNow.Add(DropboxRemovalGrace+time.Minute), 10)
	assert.Empty(t, due, "a retry waits its time")
	due, _ = ob.DueRemovals(ctx, removalNow.Add(DropboxRemovalGrace+time.Hour), 10)
	assert.Len(t, due, 1)
}

// Mutants: the guard off; only the 51st held (the first 50 would still empty the backup); a bulk delete not held; Confirm not letting them go.
func TestManyDeletesInAnHourAreHeldForTheOperator(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	for i := 0; i < DropboxRemovalGuard; i++ {
		st, err := ob.QueueRemoval(ctx, fmt.Sprintf("%064x", i), "f", removalNow.Add(time.Duration(i)*time.Second), false)
		require.NoError(t, err)
		require.Equal(t, DropboxRemovalWaiting, st, "the first %d wait as usual", DropboxRemovalGuard)
	}
	st, err := ob.QueueRemoval(ctx, rmHex("f"), "f", removalNow.Add(time.Minute), false)
	require.NoError(t, err)
	assert.Equal(t, DropboxRemovalHeld, st)
	c, err := ob.RemovalCounts(ctx)
	require.NoError(t, err)
	assert.Equal(t, DropboxRemovalGuard+1, c[DropboxRemovalHeld], "every removal of that hour is held, not only the last")
	due, _ := ob.DueRemovals(ctx, removalNow.Add(48*time.Hour), 100)
	assert.Empty(t, due, "nothing held runs")
	n, err := ob.ConfirmHeld(ctx)
	require.NoError(t, err)
	assert.Equal(t, DropboxRemovalGuard+1, n)
	due, _ = ob.DueRemovals(ctx, removalNow.Add(48*time.Hour), 100)
	assert.Len(t, due, DropboxRemovalGuard+1)

	ob2 := NewDropboxOutbox(openTestDB(t))
	st, err = ob2.QueueRemoval(ctx, rmHex("b"), "v", removalNow, true)
	require.NoError(t, err)
	assert.Equal(t, DropboxRemovalHeld, st, "one delete of many files (a series) is held")
	r, ok, err := ob2.Removal(ctx, rmHex("b"))
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, DropboxRemovalHeldBulk, r.Reason)
	// An hour later the count starts again.
	st, _ = ob.QueueRemoval(ctx, rmHex("c"), "x", removalNow.Add(3*time.Hour), false)
	assert.Equal(t, DropboxRemovalWaiting, st)
}

// Mutants: Cancel not removing the row; Cancel all touching another state; kept and edited not recorded; a name with hidden characters kept.
func TestCancelKeepAndEditedRemovals(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	_, _ = ob.QueueRemoval(ctx, rmHex("a"), "a\u202eb\x00.md", removalNow, false)
	_, _ = ob.QueueRemoval(ctx, rmHex("b"), "b", removalNow, false)
	_, _ = ob.QueueRemoval(ctx, rmHex("c"), "c", removalNow, true)
	r, _, _ := ob.Removal(ctx, rmHex("a"))
	assert.Equal(t, "ab.md", r.Name, "no control or bidi characters in a name shown in Settings")
	assert.Equal(t, 128, len(cleanName(strings.Repeat("x", 300))))
	had, err := ob.CancelRemoval(ctx, rmHex("a"))
	require.NoError(t, err)
	assert.True(t, had)
	had, _ = ob.CancelRemoval(ctx, rmHex("a"))
	assert.False(t, had)
	require.NoError(t, ob.KeepRemoval(ctx, rmHex("b"), "others_offloaded", []string{"a3f2", "9b1c"}, 1))
	r, _, _ = ob.Removal(ctx, rmHex("b"))
	assert.Equal(t, DropboxRemovalKept, r.State)
	assert.Equal(t, []string{"a3f2", "9b1c"}, r.OthersList())
	assert.Equal(t, 1, r.Unknown)
	n, err := ob.CancelRemovals(ctx, DropboxRemovalHeld)
	require.NoError(t, err)
	assert.Equal(t, 1, n)
	_, ok, _ := ob.Removal(ctx, rmHex("b"))
	assert.True(t, ok, "Keep them in Dropbox for the held rows leaves the kept one")
	_, _ = ob.QueueRemoval(ctx, rmHex("d"), "d", removalNow, false)
	require.NoError(t, ob.EditedRemoval(ctx, rmHex("d"), `[{"path":"/v1/p","rev":"r2"}]`))
	r, _, _ = ob.Removal(ctx, rmHex("d"))
	assert.Equal(t, DropboxRemovalEdited, r.State)
	due, _ := ob.DueRemovals(ctx, removalNow.Add(48*time.Hour), 10)
	assert.Empty(t, due, "kept and edited removals never run on their own")
	all, err := ob.Removals(ctx, 10)
	require.NoError(t, err)
	assert.Len(t, all, 2)
}

func rmHex(c string) string { return strings.Repeat(c, 64) }
