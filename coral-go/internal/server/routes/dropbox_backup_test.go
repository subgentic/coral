package routes

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14655, Dropbox stage 4: the upload worker, against the fake Dropbox of dropbox_routes_test.go.

type backupEnv struct {
	*dropboxEnv
	b       *DropboxBackup
	private map[string]bool
	privErr error
}

func newBackupEnv(t *testing.T) *backupEnv {
	t.Helper()
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	be := &backupEnv{dropboxEnv: e, private: map[string]bool{}}
	be.b = e.h.NewDropboxBackup(store.NewDropboxOutbox(e.db))
	be.b.private = func(context.Context, []string) (map[string]bool, error) { return be.private, be.privErr }
	be.b.power = func() (bool, bool) { return false, false }
	return be
}

// put stores an artifact as an agent's upload, which queues it.
func (be *backupEnv) put(name, mediaType, text string) string {
	be.t.Helper()
	d, _, err := storeArtifactVia(be.h.dbx.dataDir, "sess-1", name, mediaType, "", "", "", []byte(text))
	require.NoError(be.t, err)
	return d
}

func (be *backupEnv) pass() {
	be.t.Helper()
	be.b.Pass(context.Background())
}

var versionPath = regexp.MustCompile(`^/v1/[0-9a-f]{3}/[0-9a-f]{32}/v1-[0-9a-f]{8}\.(md|png|txt|bin)$`)

func TestAnUploadIsBackedUpWithItsItemData(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("plan.md", "text/markdown", "# the plan")
	be.pass()
	var version, item string
	for p := range be.dbx.files {
		switch {
		case strings.HasSuffix(p, ".item_data.json"):
			item = p
		default:
			version = p
		}
	}
	require.Regexp(t, versionPath, version, "ids only in the path, and the extension from the closed map")
	assert.Contains(t, version, "/v1-"+d[:8]+".md")
	assert.Equal(t, "# the plan", string(be.dbx.files[version]))
	require.NotEmpty(t, item)
	assert.Equal(t, strings.TrimSuffix(version, ".md")+".item_data.json", item)
	var m map[string]any
	require.NoError(t, json.Unmarshal(be.dbx.files[item], &m))
	allowed := map[string]bool{"name": true, "server_id": true, "project": true, "agent": true, "session": true, "board": true, "task_id": true, "goal_id": true, "uploaded_at": true, "upload_count": true, "digest": true}
	for k := range m {
		assert.True(t, allowed[k], "item_data field %q is not on the closed list", k)
	}
	assert.Equal(t, "plan.md", m["name"])
	assert.Equal(t, d, m["digest"])
	assert.Len(t, be.dbx.files[item], len(be.dbx.files[item]))
	assert.LessOrEqual(t, len(be.dbx.files[item]), 4096)
	c, err := be.b.outbox.Counts(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, c.BackedUp)
	assert.Equal(t, 0, c.Pending)
}

func TestNothingIsSentWhileTheDataFolderLooksLikeACopy(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "a")
	be.machine = "machine-2"
	be.pass()
	assert.Empty(t, be.dbx.files)
	assert.Zero(t, be.dbx.finishCalls)
}

func TestTheReadinessIsCheckedAgainBeforeEachCommit(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "a")
	be.dbx.onStart = func() { be.machine = "machine-2" } // the data folder becomes a copy mid-pass (Security's change a)
	be.pass()
	assert.Zero(t, be.dbx.finishCalls, "the batch is not committed")
	assert.Empty(t, be.dbx.files)
}

func TestAFileAlreadyThereIsNeverOverwritten(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "mine")
	// Learn the path the worker uses, then make the fake hold other bytes there before the next upload of a new file.
	be.pass()
	var p string
	for k := range be.dbx.files {
		if !strings.HasSuffix(k, ".item_data.json") {
			p = k
		}
	}
	require.NotEmpty(t, p)
	// A second artifact whose path is already taken by different bytes.
	d2 := be.put("b.md", "text/markdown", "theirs-to-be")
	for k := range be.dbx.files {
		delete(be.dbx.files, k)
	}
	path2 := ""
	rows, err := be.b.outbox.Next(context.Background(), be.b.now(), 10)
	require.NoError(t, err)
	for _, r := range rows {
		if r.Digest == d2 && r.Kind == store.DropboxKindVersion {
			path2 = r.Path
		}
	}
	require.NotEmpty(t, path2)
	be.dbx.files[path2] = []byte("someone else's bytes")
	be.pass()
	assert.Equal(t, "someone else's bytes", string(be.dbx.files[path2]), "never overwritten")
	c, err := be.b.outbox.Counts(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, c.Conflict, "parked as a conflict")
	be.pass()
	c2, _ := be.b.outbox.Counts(context.Background())
	assert.Equal(t, c.Conflict, c2.Conflict, "a conflict is not retried in a loop")
}

func TestAPrivateArtifactIsNotSentAndAnUnreadableMarkSendsNothing(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("secret-plan.md", "text/markdown", "private")
	be.private[d] = true
	be.pass()
	assert.Empty(t, be.dbx.files)
	be.private = map[string]bool{}
	be.privErr = errors.New("board unreadable")
	be.put("other.md", "text/markdown", "other")
	be.pass()
	assert.Empty(t, be.dbx.files, "a mark that cannot be read means nothing is sent (fail closed)")
}

func TestADeletedArtifactIsNeverUploaded(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("gone.md", "text/markdown", "bye")
	_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, d)
	require.NoError(t, err)
	be.pass()
	assert.Empty(t, be.dbx.files, "the delete cancelled its queued rows")

	d2 := be.put("vanished.md", "text/markdown", "poof")
	require.NoError(t, os.Remove(filepath.Join(be.h.dbx.dataDir, "artifacts", "objects", d2)))
	be.pass()
	assert.Empty(t, be.dbx.files)
	c, _ := be.b.outbox.Counts(context.Background())
	assert.GreaterOrEqual(t, c.Skipped, 1, "an object gone at read time is skipped, not retried")
}

func TestASecretShapedTextIsBackedUpWithAFlag(t *testing.T) {
	be := newBackupEnv(t)
	be.put("notes.md", "text/markdown", "key: sk-ant-api03-"+strings.Repeat("Ab1", 20))
	be.pass()
	assert.Len(t, be.dbx.files, 2, "uploaded (the Operator's choice)")
	var flagged int
	require.NoError(t, be.db.GetContext(context.Background(), &flagged, "SELECT COUNT(*) FROM dropbox_outbox WHERE secret_flag = 1"))
	assert.Equal(t, 1, flagged, "and flagged")
}

func TestAFullDropboxPausesTheBackup(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "a")
	be.dbx.used, be.dbx.alloc = 95, 100
	be.pass()
	assert.Empty(t, be.dbx.files, "stops at 90% of the space")
}

func TestARevokedSignInPausesTheBackup(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "a")
	be.dbx.refreshDead = true
	be.pass()
	assert.Empty(t, be.dbx.files)
	assert.Equal(t, "reconnect", be.status()["state"])
}

func TestTheFiltersChooseWhatIsSent(t *testing.T) {
	be := newBackupEnv(t)
	be.b.types = func() map[string]bool { return map[string]bool{"md": true} }
	be.put("a.md", "text/markdown", "a")
	be.put("b.png", "image/png", "\x89PNG\r\n\x1a\n")
	be.pass()
	for p := range be.dbx.files {
		assert.False(t, strings.Contains(p, ".png"), "a type that is not chosen is not sent")
	}
	assert.Len(t, be.dbx.files, 2)
}

func TestOnBatteryNothingIsSent(t *testing.T) {
	be := newBackupEnv(t)
	be.b.power = func() (bool, bool) { return true, false }
	be.put("a.md", "text/markdown", "a")
	be.pass()
	assert.Empty(t, be.dbx.files)
}
