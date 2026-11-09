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

// #14845, Dropbox stage 6b (Free up space): the setting, the record of freed artifacts and opens, and the candidates of a pass. Each test names
// the mutant it fails against.

var offloadNow = time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)

// backedUp adds a version file and its sidecar, both done in account acct, for the bytes digest of document doc; it returns the version row id.
func backedUp(t *testing.T, ob *DropboxOutbox, acct, doc, digest string, at time.Time) int64 {
	t.Helper()
	ctx := context.Background()
	base := fmt.Sprintf("/v1/%s/%s/v1-%s", doc[:3], doc, digest[:8])
	var vid int64
	for _, k := range []string{DropboxKindVersion, DropboxKindItemData} {
		path := base + ".md"
		if k == DropboxKindItemData {
			path = base + ".item_data.json"
		}
		_, err := ob.Enqueue(ctx, DropboxOutboxRow{Kind: k, Digest: digest, DocID: doc, Version: 1, Path: path, ArtifactAt: ts(at)})
		require.NoError(t, err)
		var id int64
		require.NoError(t, ob.db.GetContext(ctx, &id, "SELECT id FROM dropbox_outbox WHERE path = ?", path))
		require.NoError(t, ob.MarkDoneBy(ctx, id, acct, 100, "id:"+path, "rev-"+path, "hash-"+path))
		if k == DropboxKindVersion {
			vid = id
		}
	}
	return vid
}

func candidateDigests(t *testing.T, ob *DropboxOutbox, acct string) []string {
	t.Helper()
	rows, err := ob.OffloadCandidates(context.Background(), acct, offloadNow.Add(-90*24*time.Hour), offloadNow.Add(-DropboxOffloadOpenedFor), 100)
	require.NoError(t, err)
	out := []string{}
	for _, r := range rows {
		out = append(out, r.Digest)
	}
	return out
}

func hex64(c string) string { return strings.Repeat(c, 64) }

// Mutants: the age, the account or the exact /v1/ prefix not checked; a young, foreign or outside file offered.
func TestOnlyOldVersionFilesOfThisAccountUnderV1AreCandidates(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	old := offloadNow.Add(-200 * 24 * time.Hour)
	backedUp(t, ob, "dbid:A", "0123456789abcdef0123456789abcdef", hex64("a"), old)
	backedUp(t, ob, "dbid:A", "1123456789abcdef0123456789abcdef", hex64("b"), offloadNow.Add(-10*24*time.Hour)) // too young
	backedUp(t, ob, "dbid:B", "2123456789abcdef0123456789abcdef", hex64("c"), old)                              // another account
	vid := backedUp(t, ob, "dbid:A", "3123456789abcdef0123456789abcdef", hex64("d"), old)
	_, err := ob.db.Exec("UPDATE dropbox_outbox SET path = '/V1/' || substr(path, 5) WHERE id = ?", vid) // not this Coral's /v1/ (SQLite's LIKE would ignore the case)
	require.NoError(t, err)
	assert.Equal(t, []string{hex64("a")}, candidateDigests(t, ob, "dbid:A"))
	cands, err := ob.OffloadCandidates(context.Background(), "", offloadNow, offloadNow, 10)
	assert.Error(t, err, "no account: no candidates at all")
	assert.Empty(t, cands)
}

// Mutants (one per case): each exclusion of Security's condition 7 and the delta dropped. A candidate must have every ledger row of its bytes done,
// a done sidecar, no open edit, no offload row, no keep, no star of anyone, and no open in the last 30 days.
func TestEveryExclusionKeepsTheCandidateOut(t *testing.T) {
	old := offloadNow.Add(-200 * 24 * time.Hour)
	doc := "0123456789abcdef0123456789abcdef"
	cases := map[string]func(t *testing.T, ob *DropboxOutbox, vid int64){
		"sidecar not done": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("UPDATE dropbox_outbox SET state = 'queued' WHERE kind = 'item_data'")
			require.NoError(t, err)
		},
		"no sidecar": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("DELETE FROM dropbox_outbox WHERE kind = 'item_data'")
			require.NoError(t, err)
		},
		"edited in Dropbox":   func(t *testing.T, ob *DropboxOutbox, vid int64) { setState(t, ob, vid, DropboxOutboxEdited) },
		"removed (6a)":        func(t *testing.T, ob *DropboxOutbox, vid int64) { setState(t, ob, vid, DropboxOutboxRemoved) },
		"retained out":        func(t *testing.T, ob *DropboxOutbox, vid int64) { setState(t, ob, vid, DropboxOutboxRetainedOut) },
		"in a delete job":     func(t *testing.T, ob *DropboxOutbox, vid int64) { setState(t, ob, vid, DropboxOutboxDeleting) },
		"gone from its place": func(t *testing.T, ob *DropboxOutbox, vid int64) { setState(t, ob, vid, DropboxOutboxGone) },
		"another document queued": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.Enqueue(context.Background(), DropboxOutboxRow{Kind: DropboxKindVersion, Digest: hex64("a"), DocID: "9123456789abcdef0123456789abcdef", Path: "/v1/912/x/v1-aaaaaaaa.md", ArtifactAt: ts(old)})
			require.NoError(t, err)
		},
		"another document private": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.Enqueue(context.Background(), DropboxOutboxRow{Kind: DropboxKindVersion, Digest: hex64("a"), DocID: "9123456789abcdef0123456789abcdef", Path: "/v1/912/x/v1-aaaaaaaa.md", ArtifactAt: ts(old)})
			require.NoError(t, err)
			_, err = ob.db.Exec("UPDATE dropbox_outbox SET state = 'private' WHERE path = '/v1/912/x/v1-aaaaaaaa.md'")
			require.NoError(t, err)
		},
		"the sidecar in another account": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("UPDATE dropbox_outbox SET account_id = 'dbid:B' WHERE kind = 'item_data'")
			require.NoError(t, err)
		},
		"an open edit of the document": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			require.NoError(t, NewDropboxEdits(ob.db).Hold(context.Background(), DropboxEdit{AccountID: "dbid:A", DocID: doc, Version: 1, OrigDigest: hex64("a"), Path: "/v1/x", Digest: hex64("e"), MediaType: "text/markdown", Size: 1, Rev: "r"}))
		},
		"already freed": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			require.NoError(t, ob.RecordOffloaded(context.Background(), DropboxOffloaded{Digest: hex64("a"), AccountID: "dbid:A", Path: "/v1/p", Rev: "r", ContentHash: "h", Size: 100}))
		},
		"kept by the Operator": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("INSERT INTO artifact_keep (hex, kept_at) VALUES (?, ?)", hex64("a"), ts(old))
			require.NoError(t, err)
		},
		"starred by the owner": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("INSERT INTO artifact_stars (hex, starred_at) VALUES (?, ?)", hex64("a"), ts(old))
			require.NoError(t, err)
		},
		"starred by a Hub user": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			_, err := ob.db.Exec("INSERT INTO artifact_person_stars (person, hex, starred_at) VALUES ('p', ?, ?)", hex64("a"), ts(old))
			require.NoError(t, err)
		},
		"opened 10 days ago": func(t *testing.T, ob *DropboxOutbox, vid int64) {
			require.NoError(t, ob.RecordOpened(context.Background(), hex64("a"), offloadNow.Add(-10*24*time.Hour)))
		},
	}
	for name, exclude := range cases {
		t.Run(name, func(t *testing.T) {
			ob := NewDropboxOutbox(openTestDB(t))
			vid := backedUp(t, ob, "dbid:A", doc, hex64("a"), old)
			require.Equal(t, []string{hex64("a")}, candidateDigests(t, ob, "dbid:A"), "a candidate before")
			exclude(t, ob, vid)
			assert.Empty(t, candidateDigests(t, ob, "dbid:A"))
		})
	}
}

func setState(t *testing.T, ob *DropboxOutbox, id int64, state string) {
	t.Helper()
	_, err := ob.db.Exec("UPDATE dropbox_outbox SET state = ? WHERE id = ?", state, id)
	require.NoError(t, err)
}

// Mutant: the open record not consulted, or a later open lowered by an earlier one (MAX). An open 40 days ago does not hold it back.
func TestAnOpenLongAgoDoesNotHoldItAndALaterOpenWins(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	backedUp(t, ob, "dbid:A", "0123456789abcdef0123456789abcdef", hex64("a"), offloadNow.Add(-200*24*time.Hour))
	require.NoError(t, ob.RecordOpened(ctx, hex64("a"), offloadNow.Add(-40*24*time.Hour)))
	assert.Equal(t, []string{hex64("a")}, candidateDigests(t, ob, "dbid:A"))
	require.NoError(t, ob.RecordOpened(ctx, hex64("a"), offloadNow.Add(-1*24*time.Hour)))
	require.NoError(t, ob.RecordOpened(ctx, hex64("a"), offloadNow.Add(-50*24*time.Hour))) // an older record never lowers it
	assert.Empty(t, candidateDigests(t, ob, "dbid:A"))
}

// Mutant: one candidate per ledger row instead of per object (the same bytes in two documents would be freed twice).
func TestTheSameBytesInTwoDocumentsAreOneCandidate(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	old := offloadNow.Add(-200 * 24 * time.Hour)
	first := backedUp(t, ob, "dbid:A", "0123456789abcdef0123456789abcdef", hex64("a"), old)
	backedUp(t, ob, "dbid:A", "5123456789abcdef0123456789abcdef", hex64("a"), old.Add(time.Hour))
	rows, err := ob.OffloadCandidates(context.Background(), "dbid:A", offloadNow.Add(-90*24*time.Hour), offloadNow.Add(-DropboxOffloadOpenedFor), 100)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, first, rows[0].ID, "the oldest version file that holds the bytes")
	assert.NotEmpty(t, rows[0].ContentHash)
	assert.NotEmpty(t, rows[0].Rev)
}

// Mutants: a second row for one object accepted; a row without its rev or content hash accepted; the totals not summed.
func TestTheOffloadRecord(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	r := DropboxOffloaded{Digest: hex64("a"), AccountID: "dbid:A", Path: "/v1/p", Rev: "r1", ContentHash: "h1", Size: 100}
	require.NoError(t, ob.RecordOffloaded(ctx, r))
	assert.Error(t, ob.RecordOffloaded(ctx, r), "one object is freed once")
	assert.Error(t, ob.RecordOffloaded(ctx, DropboxOffloaded{Digest: hex64("b"), AccountID: "dbid:A", Path: "/v1/q", ContentHash: "h"}), "no rev")
	assert.Error(t, ob.RecordOffloaded(ctx, DropboxOffloaded{Digest: hex64("b"), AccountID: "dbid:A", Path: "/v1/q", Rev: "r"}), "no content hash")
	require.NoError(t, ob.RecordOffloaded(ctx, DropboxOffloaded{Digest: hex64("c"), AccountID: "dbid:A", Path: "/v1/r", Rev: "r", ContentHash: "h", Size: 50}))
	got, ok, err := ob.Offloaded(ctx, hex64("a"))
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "r1", got.Rev)
	n, b, err := ob.OffloadedTotals(ctx)
	require.NoError(t, err)
	assert.Equal(t, 2, n)
	assert.EqualValues(t, 150, b)
	require.NoError(t, ob.ForgetOffloaded(ctx, hex64("a")))
	_, ok, err = ob.Offloaded(ctx, hex64("a"))
	require.NoError(t, err)
	assert.False(t, ok)
	all, err := ob.OffloadedAll(ctx, 10)
	require.NoError(t, err)
	require.Len(t, all, 1)
	assert.Equal(t, hex64("c"), all[0].Digest)
}

// Mutants: the bounds not checked; a new sign-in, a disconnect or a re-key leaving Free up space on (it must be turned on again through the
// confirms); the offload audit kinds refused.
func TestTheOffloadSettingIsOffByDefaultAndEveryNewSignInTurnsItOff(t *testing.T) {
	ds, _, _ := dropboxStore(t)
	ctx := context.Background()
	days, last, err := ds.Offload(ctx)
	require.NoError(t, err)
	assert.Equal(t, 0, days, "off by default")
	assert.Empty(t, last)
	for _, bad := range []int{-1, 1, 29, 3651} {
		assert.Error(t, ds.SetOffload(ctx, bad), "%d days", bad)
	}
	require.NoError(t, ds.SetOffload(ctx, 90))
	require.NoError(t, ds.SetOffloadPass(ctx, ts(offloadNow)))
	days, last, _ = ds.Offload(ctx)
	assert.Equal(t, 90, days)
	assert.Equal(t, ts(offloadNow), last)

	require.NoError(t, ds.Save(ctx, "dbid:A", "refresh", "fp"))
	days, _, _ = ds.Offload(ctx)
	assert.Equal(t, 0, days, "a new sign-in turns it off")
	require.NoError(t, ds.SetOffload(ctx, 90))
	require.NoError(t, ds.Disconnect(ctx))
	days, _, _ = ds.Offload(ctx)
	assert.Equal(t, 0, days, "a disconnect turns it off")

	for _, k := range []string{DropboxAuditOffloadSetting, DropboxAuditOffloadPass} {
		require.NoError(t, ds.AddAudit(ctx, DropboxAudit{Kind: k, Count: 3}))
	}
}

// Security's 3c on d766be37a. Mutant: retention's due list keeps an offloaded digest (a failed or stale marker listing would then cost the only copy).
func TestRetentionNeverTakesAnOffloadedDigest(t *testing.T) {
	ob := NewDropboxOutbox(openTestDB(t))
	ctx := context.Background()
	old := offloadNow.Add(-200 * 24 * time.Hour)
	backedUp(t, ob, "dbid:A", "0123456789abcdef0123456789abcdef", hex64("a"), old)
	backedUp(t, ob, "dbid:A", "1123456789abcdef0123456789abcdef", hex64("b"), old)
	require.NoError(t, ob.RecordOffloaded(ctx, DropboxOffloaded{Digest: hex64("a"), AccountID: "dbid:A", Path: "/v1/p", Rev: "r", ContentHash: "h", Size: 1}))
	rows, err := ob.DueForRetention(ctx, "dbid:A", offloadNow, 100)
	require.NoError(t, err)
	for _, r := range rows {
		assert.NotEqual(t, hex64("a"), r.Digest, "never the only copy")
	}
	assert.Len(t, rows, 2, "the other document's version and sidecar are due")
}
