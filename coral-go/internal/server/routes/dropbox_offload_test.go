package routes

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14845, Dropbox stage 6b piece 2: the offload pass, against the fake Dropbox. Each test names the mutant it fails against.

// offloadEnv backs up one artifact, makes it 200 days old, turns Free up space on (90 days) and gives the pass an empty reference scan.
func offloadEnv(t *testing.T) (*backupEnv, string) {
	t.Helper()
	be := newBackupEnv(t)
	d := be.put("old.md", "text/markdown", "# an old file\n")
	be.pass()
	require.Equal(t, 2, be.inDropbox(d))
	_, err := be.db.Exec("UPDATE dropbox_outbox SET artifact_at = ? WHERE digest = ?", time.Now().Add(-200*24*time.Hour).UTC().Format(time.RFC3339), d)
	require.NoError(t, err)
	require.NoError(t, be.h.dbx.store.SetOffload(context.Background(), 90))
	be.b.references = func(context.Context) (map[string]bool, error) { return map[string]bool{}, nil }
	return be, d
}

func (be *backupEnv) offloaded(d string) bool {
	be.t.Helper()
	_, ok, err := be.b.outbox.Offloaded(context.Background(), d)
	require.NoError(be.t, err)
	return ok
}

func (be *backupEnv) objectHereNow(d string) bool {
	_, err := os.Lstat(be.objectPath(d))
	return err == nil
}

func (be *backupEnv) markerOf(d string) bool {
	id, _ := be.h.dbx.store.ServerID(context.Background())
	be.dbx.mu.Lock()
	defer be.dbx.mu.Unlock()
	_, ok := be.dbx.files[offloadMarker(d, id)]
	return ok
}

// Conditions 1, 3 and 4. Mutants: the bytes removed before the marker or the row; the sidecar or the records removed with them; the probe left behind.
func TestTheOffloadPassFreesAnOldBackedUpObject(t *testing.T) {
	be, d := offloadEnv(t)
	n, freed := be.b.Offload(context.Background())
	require.Equal(t, 1, n)
	assert.Positive(t, freed)
	assert.False(t, be.objectHereNow(d), "the local bytes are freed")
	assert.True(t, be.offloaded(d), "the offload row says where the copy is")
	assert.True(t, be.markerOf(d), "this Coral's marker is in Dropbox")
	_, err := os.Lstat(be.objectPath(d) + ".json")
	assert.NoError(t, err, "the sidecar stays: the artifact is still listed")
	assert.True(t, be.hasRecord(d), "its upload records stay")
	be.dbx.mu.Lock()
	for p := range be.dbx.files {
		assert.False(t, strings.HasPrefix(p, "/v1/probe/"), "the probe is deleted: %s", p)
	}
	be.dbx.mu.Unlock()
	a, _ := be.h.dbx.store.Audits(context.Background(), 1)
	require.Len(t, a, 1)
	assert.Equal(t, store.DropboxAuditOffloadPass, a[0].Kind)
	assert.Equal(t, 1, a[0].Count)
	n, _ = be.b.Offload(context.Background())
	assert.Zero(t, n, "at most once an hour")
}

// Mutants (one per case): each refusal dropped. Nothing is freed when the setting is off, the probe fails or reads back other bytes, the private
// marks or the reference scan cannot be read (fail closed), the artifact is private or referenced, or Dropbox's copy is not these exact bytes.
func TestTheOffloadPassFreesNothingUnlessEveryCheckHolds(t *testing.T) {
	cases := map[string]func(t *testing.T, be *backupEnv, d string){
		"the setting off": func(t *testing.T, be *backupEnv, d string) {
			require.NoError(t, be.h.dbx.store.SetOffload(context.Background(), 0))
		},
		"the probe unreadable":     func(t *testing.T, be *backupEnv, d string) { be.dbx.failDownloads = 1 },
		"the probe's bytes differ": func(t *testing.T, be *backupEnv, d string) { be.dbx.probeBad = true },
		"private marks unreadable": func(t *testing.T, be *backupEnv, d string) { be.privErr = errors.New("board unreadable") },
		"marked private":           func(t *testing.T, be *backupEnv, d string) { be.private[d] = true },
		"the reference scan fails": func(t *testing.T, be *backupEnv, d string) {
			be.b.references = func(context.Context) (map[string]bool, error) { return nil, errors.New("no scan") }
		},
		"a running task names it": func(t *testing.T, be *backupEnv, d string) {
			be.b.references = func(context.Context) (map[string]bool, error) { return map[string]bool{d: true}, nil }
		},
		"edited in Dropbox (another rev)": func(t *testing.T, be *backupEnv, d string) {
			be.dbx.revs = map[string]string{be.versionFile(d): "r2"}
		},
		"the local bytes are not the digest": func(t *testing.T, be *backupEnv, d string) {
			require.NoError(t, os.WriteFile(be.objectPath(d), []byte("other bytes"), 0o600))
		},
		"on battery": func(t *testing.T, be *backupEnv, d string) { be.b.power = func() (bool, bool) { return true, false } },
	}
	for name, refuse := range cases {
		t.Run(name, func(t *testing.T) {
			be, d := offloadEnv(t)
			refuse(t, be, d)
			n, _ := be.b.Offload(context.Background())
			assert.Zero(t, n)
			assert.True(t, be.objectHereNow(d), "the bytes stay")
			assert.False(t, be.offloaded(d), "no offload row")
		})
	}
}

// Condition 1a. Mutant: a probe a crash left is not deleted (it piles up, and the next listing would count it).
func TestAProbeACrashLeftIsDeleted(t *testing.T) {
	be, _ := offloadEnv(t)
	id, _ := be.h.dbx.store.ServerID(context.Background())
	be.dbx.mu.Lock()
	be.dbx.files["/v1/probe/"+id+"/left"] = []byte("x")
	be.dbx.mu.Unlock()
	n, _ := be.b.Offload(context.Background())
	require.Equal(t, 1, n)
	be.dbx.mu.Lock()
	defer be.dbx.mu.Unlock()
	for p := range be.dbx.files {
		assert.False(t, strings.HasPrefix(p, "/v1/probe/"), "no probe stays: %s", p)
	}
}
