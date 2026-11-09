package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14703, Dropbox stage 4b: retention, against the fake Dropbox. Each test names the mutant it fails against.

// newRetentionEnv backs up n artifacts (2n files with their sidecars).
func newRetentionEnv(t *testing.T, n int) (*backupEnv, []string) {
	t.Helper()
	be := newBackupEnv(t)
	be.b.retainPoll, be.b.retainWait = time.Millisecond, 50*time.Millisecond
	var ds []string
	for i := 0; i < n; i++ {
		ds = append(ds, be.put(fmt.Sprintf("a%d.md", i), "text/markdown", fmt.Sprintf("body %d", i)))
	}
	be.pass()
	require.Len(t, be.dbx.files, 2*n)
	return be, ds
}

// age makes these artifacts days old, by Coral's own time.
func (be *backupEnv) age(days int, digests ...string) {
	be.t.Helper()
	at := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
	for _, d := range digests {
		_, err := be.db.ExecContext(context.Background(), "UPDATE dropbox_outbox SET artifact_at = ? WHERE digest = ?", at, d)
		require.NoError(be.t, err)
	}
}

// retain turns retention on at days and runs a pass now (the hourly gate reset).
func (be *backupEnv) retain(days int) {
	be.t.Helper()
	require.NoError(be.t, be.h.dbx.store.SetRetention(context.Background(), days))
	be.b.lastRetain = time.Time{}
	be.b.Retain(context.Background())
}

func (be *backupEnv) audits() []store.DropboxAudit {
	be.t.Helper()
	a, err := be.h.dbx.store.Audits(context.Background(), 50)
	require.NoError(be.t, err)
	return a
}

func (be *backupEnv) inDropbox(d string) int {
	n := 0
	for p := range be.dbx.files {
		if strings.Contains(p, "/v1-"+d[:8]) {
			n++
		}
	}
	return n
}

// Mutant: Retain runs with retention_days 0.
func TestRetentionIsOffByDefault(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(30, ds...)
	be.b.lastRetain = time.Time{}
	be.b.Retain(context.Background())
	assert.Len(t, be.dbx.files, 8)
	assert.Empty(t, be.dbx.deleteCalls)
}

// Mutants: the age cut uses now instead of now - N; the pair is split; the local copy is removed.
func TestRetentionDeletesOnlyOldPairsAndNeverTheLocalCopy(t *testing.T) {
	be, ds := newRetentionEnv(t, 8) // a ceiling of 8 files: room for more than the old pairs, so only the age chooses
	be.age(10, ds[0], ds[1])
	be.retain(7)
	assert.Zero(t, be.inDropbox(ds[0]), "old: the version and its sidecar are gone from Dropbox")
	assert.Zero(t, be.inDropbox(ds[1]))
	for _, d := range ds[2:] {
		assert.Equal(t, 2, be.inDropbox(d), "new: kept")
	}
	require.Len(t, be.dbx.deleteCalls, 1)
	assert.Len(t, be.dbx.deleteCalls[0], 4, "two whole pairs in one batch")
	for _, d := range ds {
		_, err := os.Stat(be.objectPath(d))
		assert.NoError(t, err, "the local copy is never touched")
	}
	c := be.counts()
	assert.Equal(t, 4, c.RetainedOut)
	assert.Equal(t, 12, c.BackedUp)
	a := be.audits()
	require.NotEmpty(t, a)
	assert.Equal(t, store.DropboxAuditPass, a[0].Kind)
	assert.Equal(t, 4, a[0].Count)
	assert.Positive(t, a[0].Bytes)
}

// Mutant: the ceiling is not half the ledger.
func TestRetentionNeverDeletesMoreThanHalfTheLedger(t *testing.T) {
	be, ds := newRetentionEnv(t, 6) // 12 files: at most 6 a pass, in whole pairs
	be.age(10, ds[:4]...)           // 8 files due
	be.retain(1)
	assert.Len(t, be.dbx.files, 6, "three pairs deleted")
	a := be.audits()
	assert.Equal(t, 6, a[0].Count)
	assert.Equal(t, 2, a[0].Held, "one pair waits for a later pass")
}

// Mutant: the ceiling of 100 a pass is dropped.
func TestRetentionDeletesAtMostAHundredFilesAPass(t *testing.T) {
	be, ds := newRetentionEnv(t, 120)
	be.age(10, ds...)
	be.retain(1)
	require.Len(t, be.dbx.deleteCalls, 1)
	assert.Len(t, be.dbx.deleteCalls[0], 100)
	assert.Len(t, be.dbx.files, 140)
}

// Mutant: a single backed-up artifact is deleted (half of 2 is 1: no whole pair fits).
func TestASmallLedgerNeverDeletesAndSaysWhy(t *testing.T) {
	be, ds := newRetentionEnv(t, 1)
	be.age(10, ds...)
	be.retain(1)
	assert.Len(t, be.dbx.files, 2)
	ret, _ := be.status()["retention"].(map[string]any)
	assert.Equal(t, true, ret["waiting_for_files"], "the status says it waits for 2 artifacts")
}

// Mutant: parent_rev is not sent, or a refusal is retried or counted as deleted.
func TestAFileEditedInDropboxIsKeptAndNeverRetried(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	var edited string
	for p := range be.dbx.files {
		if strings.Contains(p, "/v1-"+ds[0][:8]) && !strings.HasSuffix(p, ".item_data.json") {
			edited = p
		}
	}
	be.dbx.revs = map[string]string{edited: "r2"} // the person edited it in Dropbox
	be.retain(1)
	assert.Contains(t, be.dbx.files, edited, "Dropbox refused the delete: the edit is kept")
	c := be.counts()
	assert.Equal(t, 1, c.Edited)
	assert.Equal(t, 3, c.RetainedOut)
	be.retain(1)
	for _, call := range be.dbx.deleteCalls[1:] {
		assert.NotContains(t, call, edited, "never retried")
	}
}

// Mutants: not found is counted as retention's delete; deletes go by id (a moved file would follow).
func TestAFileNoLongerAtItsPlaceIsGoneNotRemovedByCoral(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	for p := range be.dbx.files {
		if strings.Contains(p, "/v1-"+ds[0][:8]) && !strings.HasSuffix(p, ".item_data.json") {
			be.dbx.files["/moved-by-the-person.md"] = be.dbx.files[p]
			delete(be.dbx.files, p)
		}
	}
	be.retain(1)
	assert.Contains(t, be.dbx.files, "/moved-by-the-person.md", "a moved file survives at its new place")
	c := be.counts()
	assert.Equal(t, 1, c.Gone)
	assert.Equal(t, 3, c.RetainedOut)
}

// Mutants: rows of another account, outside /v1/ or without a rev are taken.
func TestRetentionReadsOnlyThisAccountsLedgerUnderV1(t *testing.T) {
	be, ds := newRetentionEnv(t, 6)
	be.age(10, ds...)
	ctx := context.Background()
	_, err := be.db.ExecContext(ctx, "UPDATE dropbox_outbox SET account_id = 'dbid:OLD' WHERE digest = ?", ds[0])
	require.NoError(t, err)
	_, err = be.db.ExecContext(ctx, "UPDATE dropbox_outbox SET path = '/elsewhere/' || id WHERE digest = ?", ds[1])
	require.NoError(t, err)
	_, err = be.db.ExecContext(ctx, "UPDATE dropbox_outbox SET rev = NULL WHERE digest = ?", ds[2])
	require.NoError(t, err)
	be.dbx.files["/v1/abc/not-in-the-ledger.md"] = []byte("x")
	be.retain(1)
	assert.Equal(t, 2, be.inDropbox(ds[0]), "another account's files are never asked of this one")
	assert.Equal(t, 2, be.inDropbox(ds[1]))
	assert.Equal(t, 2, be.inDropbox(ds[2]), "no stored rev: never deleted")
	assert.Contains(t, be.dbx.files, "/v1/abc/not-in-the-ledger.md", "a file Coral did not store is never deleted")
	for _, call := range be.dbx.deleteCalls {
		for _, p := range call {
			assert.True(t, strings.HasPrefix(p, "/v1/"), p)
		}
	}
}

// Mutants: the clock checks are dropped.
func TestRetentionRefusesAClockBehindOrSkewed(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	ctx := context.Background()
	require.NoError(t, be.h.dbx.store.SetRetentionPass(ctx, time.Now().Add(time.Hour).UTC().Format(time.RFC3339)))
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "the local clock is earlier than the last pass")
	assert.Equal(t, "clock_behind", be.audits()[0].Reason)

	require.NoError(t, be.h.dbx.store.SetRetentionPass(ctx, ""))
	be.dbx.dateOffset = 25 * time.Hour
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "more than a day off Dropbox's clock")
	assert.Equal(t, "clock_skew", be.audits()[0].Reason)

	be.dbx.dateOffset, be.dbx.noDate = 0, true
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "no Date from Dropbox: no check, no delete")

	be.dbx.noDate = false
	be.retain(1)
	assert.NotEmpty(t, be.dbx.deleteCalls)
}

// Mutant: a running job's rows are put in a second job.
func TestARunningDeleteJobIsReadNotRepeated(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	be.dbx.asyncPolls = 1000 // still running after this pass's wait
	be.retain(1)
	require.Len(t, be.dbx.deleteCalls, 1)
	assert.Len(t, be.dbx.files, 8, "nothing deleted yet")
	be.dbx.mu.Lock()
	be.dbx.asyncPolls = 0
	be.dbx.mu.Unlock()
	be.retain(1)
	assert.Len(t, be.dbx.deleteCalls, 1, "the next pass reads the job; no second delete of the same rows")
	assert.Len(t, be.dbx.files, 4)
	assert.Equal(t, 4, be.counts().RetainedOut)
}

// Mutant: an unknown job leaves its rows deleting for ever.
func TestAJobDropboxForgotPutsTheRowsBack(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	be.dbx.asyncPolls = 1000
	be.retain(1)
	be.dbx.mu.Lock()
	be.dbx.jobs = nil // Dropbox no longer knows it
	be.dbx.asyncPolls = 0
	be.dbx.mu.Unlock()
	be.retain(1)
	assert.Len(t, be.dbx.deleteCalls, 2, "the rows went back to done and were sent again")
	assert.Equal(t, 4, be.counts().RetainedOut, "and deleted")
}

// Mutant: the keep hook (offload markers, pending edits; stages 5 and 6) is ignored.
func TestAPairAHookKeepsIsNotDeleted(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	kept := ""
	be.b.keepDoc = func(_ context.Context, doc string, _ int) bool {
		if kept == "" {
			kept = doc
		}
		return doc == kept
	}
	be.retain(1)
	assert.Equal(t, 2, be.counts().RetainedOut, "one pair kept by the hook, the other deleted")
	assert.Equal(t, 2, be.audits()[0].Held)
}

// Mutant: the hourly gate is dropped.
func TestRetentionRunsAtMostOnceAnHour(t *testing.T) {
	be, ds := newRetentionEnv(t, 6)
	be.age(10, ds...)
	be.retain(1)
	require.Len(t, be.dbx.deleteCalls, 1)
	be.b.Retain(context.Background()) // the gate is not reset
	assert.Len(t, be.dbx.deleteCalls, 1)
}

// Mutant: reconnect does not stop retention; quota_full does.
func TestRetentionStopsOnReconnectButRunsWhenFull(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	ctx := context.Background()
	require.NoError(t, be.h.dbx.store.SetState(ctx, store.DropboxStateReconnect))
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls)
	require.NoError(t, be.h.dbx.store.SetState(ctx, store.DropboxStateQuotaFull))
	be.retain(1)
	assert.NotEmpty(t, be.dbx.deleteCalls, "freeing space is the point")
}

// Mutant: the upload age ignores retention (backfill would upload what retention deletes again).
func TestWhileRetentionIsOnNothingOlderIsUploaded(t *testing.T) {
	be := newBackupEnv(t)
	assert.Zero(t, be.b.maxAge(), "no filter, no retention: every age")
	require.NoError(t, be.h.dbx.store.SetRetention(context.Background(), 3))
	assert.Equal(t, 3*24*time.Hour, be.b.maxAge())
	require.NoError(t, be.h.dbx.store.SetFilters(context.Background(), nil, 10))
	assert.Equal(t, 3*24*time.Hour, be.b.maxAge(), "the smaller of the two")
	require.NoError(t, be.h.dbx.store.SetFilters(context.Background(), nil, 2))
	assert.Equal(t, 2*24*time.Hour, be.b.maxAge())
}

// Mutants: the dry run saves; the confirm skips the audit or its seen count; an agent or a Hub request changes it.
func TestTheRetentionRouteDryRunsThenSavesWithAnAudit(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds[0], ds[1])
	put := func(body string, dashboard bool) map[string]any {
		be.body = body
		rec := be.call(http.MethodPut, "/api/dropbox/retention", dashboard, nil)
		var m map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &m)
		m["_code"] = float64(rec.Code)
		return m
	}
	dry := put(`{"days": 7}`, true)
	require.EqualValues(t, 200, dry["_code"], dry)
	assert.Equal(t, true, dry["dry_run"])
	assert.EqualValues(t, 4, dry["due"])
	assert.Positive(t, dry["bytes"])
	days, _, _ := be.h.dbx.store.Retention(context.Background())
	assert.Zero(t, days, "a dry run saves nothing")
	assert.Empty(t, be.dbx.deleteCalls, "and calls nothing")

	assert.NotEqualValues(t, 200, put(`{"days": 7, "confirm": true}`, false)["_code"], "not from outside the dashboard")
	assert.NotEqualValues(t, 200, put(`{"days": 7, "confirm": true, "extra": 1}`, true)["_code"], "unknown fields are refused")
	assert.NotEqualValues(t, 200, put(`{"days": 4000, "confirm": true}`, true)["_code"])
	for _, bad := range []string{`{"days": 1.9}`, `{"days": 1.9, "confirm": true}`, `{"days": "7"}`, `{"days": -1, "confirm": true}`} {
		assert.EqualValues(t, http.StatusBadRequest, put(bad, true)["_code"], "only a whole number of days: %s", bad)
	}
	days0, _, _ := be.h.dbx.store.Retention(context.Background())
	assert.Zero(t, days0, "nothing saved by a refused body")

	ok := put(`{"days": 7, "confirm": true, "seen_count": 4, "seen_bytes": 99}`, true)
	require.EqualValues(t, 200, ok["_code"], ok)
	days, _, _ = be.h.dbx.store.Retention(context.Background())
	assert.Equal(t, 7, days)
	a := be.audits()[0]
	assert.Equal(t, store.DropboxAudit{At: a.At, Kind: "setting", Who: "operator", OldDays: 0, NewDays: 7, Count: 4, Bytes: 99}, a)

	require.EqualValues(t, 200, put(`{"days": 0}`, true)["_code"], "off needs no dry run")
	a = be.audits()[0]
	assert.Equal(t, 7, a.OldDays)
	assert.Equal(t, 0, a.NewDays)
	assert.EqualValues(t, 0, be.status()["retention"].(map[string]any)["days"])
}

// Mutant: a new sign-in or a disconnect keeps retention on.
func TestEveryNewSignInStartsWithRetentionOff(t *testing.T) {
	be := newBackupEnv(t)
	ctx := context.Background()
	require.NoError(t, be.h.dbx.store.SetRetention(ctx, 5))
	require.Contains(t, be.signIn(""), "Connected") // the same account again
	days, _, _ := be.h.dbx.store.Retention(ctx)
	assert.Zero(t, days)
	require.NoError(t, be.h.dbx.store.SetRetention(ctx, 5))
	require.NoError(t, be.h.dbx.store.Disconnect(ctx))
	days, _, _ = be.h.dbx.store.Retention(ctx)
	assert.Zero(t, days)
}

// QA Reviewer 2's gaps on #14703 (17:30), the copy check first. Each test names its mutant.

// Mutant: Retain does not check looksLikeCopy.
func TestRetentionDeletesNothingFromACopiedDataFolder(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	be.setMachine("machine-2") // this data folder now runs on another machine: it looks like a copy
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls)
	assert.Len(t, be.dbx.files, 8)
}

// Mutants: only "ahead" is checked; a zero Dropbox time passes.
func TestADropboxClockFarBehindDeletesNothing(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	be.dbx.dateOffset = -25 * time.Hour
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "Dropbox's clock a day behind ours")
	assert.Equal(t, "clock_skew", be.audits()[0].Reason)
	be.dbx.dateOffset = 0
	be.b.now = func() time.Time { return time.Time{}.Add(48 * time.Hour) } // a local clock near zero: a day off a real Dropbox time
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls)
}

// Mutant: Retain ignores the battery.
func TestOnBatteryRetentionDeletesNothing(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	be.b.power = func() (bool, bool) { return true, false }
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls)
	be.b.power = func() (bool, bool) { return false, true }
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "nor on a metered network")
}

// Mutant: the route saves retention while Dropbox is not connected.
func TestRetentionCannotBeTurnedOnWhileNotConnected(t *testing.T) {
	be := newBackupEnv(t)
	ctx := context.Background()
	require.NoError(t, be.h.dbx.store.Disconnect(ctx))
	be.body = `{"days": 7, "confirm": true}`
	rec := be.call(http.MethodPut, "/api/dropbox/retention", true, nil)
	assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "not_connected")
	days, _, _ := be.h.dbx.store.Retention(ctx)
	assert.Zero(t, days)
	be.body = `{"days": 3651, "confirm": true}`
	assert.Equal(t, http.StatusBadRequest, be.call(http.MethodPut, "/api/dropbox/retention", true, nil).Code, "over 3650 days")
	be.body = `{"days": 0}`
	assert.Equal(t, http.StatusOK, be.call(http.MethodPut, "/api/dropbox/retention", true, nil).Code, "turning it off needs no connection")
}

// Mutant: the pair grouping takes single rows, so a pair is split at the ceiling.
func TestAdjacentPairsAtTheCeilingAreNeverSplit(t *testing.T) {
	be, ds := newRetentionEnv(t, 5) // 10 files: a ceiling of 5, which fits two whole pairs and half of a third
	be.age(10, ds[0], ds[1], ds[2])
	be.retain(1)
	require.Len(t, be.dbx.deleteCalls, 1)
	assert.Len(t, be.dbx.deleteCalls[0], 4, "two whole pairs, never 5 files")
	for _, d := range ds {
		n := be.inDropbox(d)
		assert.True(t, n == 0 || n == 2, "a pair is deleted whole or kept whole (%s has %d)", d[:8], n)
	}
	assert.Equal(t, 2, be.audits()[0].Held, "the third pair waits whole")
}

// QA Reviewer 2's last two gaps on #14703.

// Mutant: the Go /v1/ check is dropped. SQLite's LIKE ignores ASCII case, so '/V1/...' passes the query's filter and only the exact prefix
// check in planRetention keeps it.
func TestNothingOutsideV1IsDeletedWhateverItsCase(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(10, ds...)
	ctx := context.Background()
	for _, d := range ds {
		_, err := be.db.ExecContext(ctx, "UPDATE dropbox_outbox SET path = '/V1/' || substr(path, 5) WHERE digest = ?", d)
		require.NoError(t, err)
	}
	be.retain(1)
	assert.Empty(t, be.dbx.deleteCalls, "a path that is not exactly under /v1/ is never deleted")
	assert.Equal(t, 8, be.audits()[0].Held, "held, and counted")
}

// Mutant: pairs are grouped without the document, so two documents with the same bytes (same digest, both version 1) merge into one group.
func TestPairsNeverCrossDocuments(t *testing.T) {
	be := newBackupEnv(t)
	be.b.retainPoll, be.b.retainWait = time.Millisecond, 50*time.Millisecond
	d := be.put("a.md", "text/markdown", "the same bytes")
	d2, _, err := storeArtifactVia(be.h.dbx.dataDir, "sess-2", "b.md", "text/markdown", "", "", "", []byte("the same bytes")) // another document, the same bytes
	require.NoError(t, err)
	require.Equal(t, d, d2)
	be.pass()
	require.Len(t, be.dbx.files, 4, "two documents: two version files and two sidecars")
	be.age(10, d)
	be.retain(1) // a ledger of 4: a ceiling of 2, one whole pair
	require.Len(t, be.dbx.deleteCalls, 1, "one document's pair fits")
	call := be.dbx.deleteCalls[0]
	require.Len(t, call, 2)
	doc := func(p string) string { return strings.Split(p, "/")[3] }
	assert.Equal(t, doc(call[0]), doc(call[1]), "both files of one document, never one from each")
	assert.Equal(t, 2, be.audits()[0].Held, "the other document's pair waits whole")
}

// Stage 6b's keepDoc MUST (#14845). Mutants: the marker listing not read (a document another Coral keeps only in Dropbox deleted); a failed listing
// read as "no markers".
func TestRetentionKeepsWhatAnyCoralKeepsOnlyInDropbox(t *testing.T) {
	be, ds := newRetentionEnv(t, 4)
	be.age(400, ds[1:]...)
	be.age(500, ds[0])                               // the oldest: the first retention would take
	be.marker(ds[0], strings.Repeat("3", 28)+"c0de") // another Coral keeps ds[0] only in Dropbox
	be.retain(30)
	assert.Equal(t, 2, be.inDropbox(ds[0]), "a document with any marker is kept")
	gone := 0
	for _, d := range ds[1:] {
		if be.inDropbox(d) == 0 {
			gone++
		}
	}
	assert.Positive(t, gone, "the others go as usual")

	be2, ds2 := newRetentionEnv(t, 4)
	be2.age(400, ds2...)
	be2.dbx.markersFail = true
	be2.retain(30)
	for _, d := range ds2 {
		assert.Equal(t, 2, be2.inDropbox(d), "an unreadable marker listing deletes nothing")
	}
	a := be2.audits()
	require.NotEmpty(t, a)
	assert.Equal(t, "markers_unreadable", a[0].Reason)
}
