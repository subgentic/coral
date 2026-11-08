package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

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

func TestTheFiltersAreTheOperatorsAndOnlyClosedTypes(t *testing.T) {
	be := newBackupEnv(t)
	put := func(body string, dashboard bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/dropbox/filters", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if dashboard {
			dashboardRequest(req)
			req.Host = be.host
		}
		rec := httptest.NewRecorder()
		be.h.DropboxSetFilters(rec, req)
		return rec
	}
	assert.Equal(t, http.StatusForbidden, put(`{"types":["md"],"max_age_days":1}`, false).Code, "not an agent's")
	assert.Equal(t, http.StatusBadRequest, put(`{"types":["html"],"max_age_days":1}`, true).Code, "only types from the closed map")
	assert.Equal(t, http.StatusBadRequest, put(`{"types":["md"],"max_age_days":-1}`, true).Code)
	require.Equal(t, http.StatusOK, put(`{"types":["md","png"],"max_age_days":1}`, true).Code)
	st := be.status()
	assert.Equal(t, map[string]any{"types": []any{"md", "png"}, "max_age_days": float64(1)}, st["filters"])

	be.put("a.md", "text/markdown", "a")
	be.put("b.txt", "text/plain", "b")
	be.pass()
	for p := range be.dbx.files {
		assert.False(t, strings.HasSuffix(p, ".txt"), "the stored filter is what the worker uses")
	}
	backup := be.status()["backup"].(map[string]any)
	assert.EqualValues(t, 2, backup["backed_up"])
	assert.EqualValues(t, 2, backup["pending"], "the txt and its sidecar wait, never deleted")
}

func TestTheBackgroundLoopBacksUpAfterAnUpload(t *testing.T) {
	be := newBackupEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go be.b.Run(ctx, time.Hour) // the five-minute tick is far off: the upload's nudge starts the pass
	be.put("nudged.md", "text/markdown", "now")
	require.Eventually(t, func() bool {
		be.dbx.mu.Lock()
		defer be.dbx.mu.Unlock()
		return len(be.dbx.files) == 2
	}, 5*time.Second, 50*time.Millisecond)
}

// A private mark set after the files were read is read again right before the commit (Security's SHOULD 3 on #14691): the marked artifact is not
// committed, and the rest of the batch is.
func TestAMarkSetMidPassStopsTheCommitOfThatArtifact(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("now-private.md", "text/markdown", "secret plan")
	be.put("public.md", "text/markdown", "fine")
	be.dbx.onStart = func() { be.private[d] = true } // marked while the sessions upload
	be.pass()
	for p, b := range be.dbx.files {
		assert.NotEqual(t, "secret plan", string(b), "the artifact marked mid-pass was committed at %s", p)
		assert.False(t, strings.Contains(p, "/v1-"+d[:8]), "nor its sidecar: %s", p)
	}
	assert.Len(t, be.dbx.files, 2, "the other artifact and its sidecar are")
}

// A private artifact's rows are parked as private, not retried every pass (Security's SHOULD 4 on #14691), and counted.
func TestPrivateRowsAreParkedNotRetried(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("p.md", "text/markdown", "p")
	be.private[d] = true
	be.pass()
	c, err := be.b.outbox.Counts(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, c.Private, "the file and its sidecar")
	assert.Equal(t, 0, c.Pending)
	rows, err := be.b.outbox.Next(context.Background(), be.b.now().Add(48*time.Hour), 10)
	require.NoError(t, err)
	assert.Empty(t, rows, "never handed out again")
}

// QA Reviewer 2's test gaps on stage 4 (#14655), Security-shaped first. Each one fails against the mutant named in its comment.

func (be *backupEnv) counts() store.DropboxOutboxCounts {
	be.t.Helper()
	c, err := be.b.outbox.Counts(context.Background())
	require.NoError(be.t, err)
	return c
}

func (be *backupEnv) objectPath(d string) string {
	return filepath.Join(be.h.dbx.dataDir, "artifacts", "objects", d)
}

// Mutant: readObject opens with os.Open (follows the link).
func TestAnObjectThatIsALinkIsRefused(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("a.md", "text/markdown", "the same bytes")
	elsewhere := filepath.Join(t.TempDir(), "outside")
	require.NoError(t, os.WriteFile(elsewhere, []byte("the same bytes"), 0o600)) // the digest still matches: only the link refuses it
	require.NoError(t, os.Remove(be.objectPath(d)))
	if err := os.Symlink(elsewhere, be.objectPath(d)); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	be.pass()
	assert.Empty(t, be.dbx.files, "nothing is read through a link, and its sidecar is not sent either")
	c := be.counts()
	assert.Equal(t, 0, c.BackedUp)
	assert.Equal(t, 0, c.Pending, "parked, not retried every pass")
}

// Mutant: readObject skips the SHA-256 check.
func TestAnObjectWhoseBytesAreNotItsDigestIsRefused(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("a.md", "text/markdown", "the real bytes")
	require.NoError(t, os.WriteFile(be.objectPath(d), []byte("changed on disk"), 0o600))
	be.pass()
	for p, b := range be.dbx.files {
		assert.True(t, strings.HasSuffix(p, ".item_data.json"), "only the sidecar may go, never the changed bytes: %s", p)
		assert.NotContains(t, string(b), "changed on disk")
	}
	assert.Equal(t, 1, be.counts().Failed, "the version is failed")
}

// Mutant: dropboxExtOf takes the extension from the media type's subtype.
func TestAnUnknownMediaTypeIsUploadedAsBin(t *testing.T) {
	for _, mt := range []string{"text/html", "text/html; charset=utf-8", "image/svg+xml", "application/javascript", ""} {
		assert.Equal(t, "bin", dropboxExtOf(mt), "%q", mt)
	}
	assert.Equal(t, "md", dropboxExtOf("Text/Markdown; charset=utf-8"), "a known type, any case, with parameters")
	be := newBackupEnv(t)
	be.put("page.html", "text/html", "<script>alert(1)</script>")
	be.pass()
	require.Len(t, be.dbx.files, 2)
	for p := range be.dbx.files {
		assert.False(t, strings.Contains(strings.ToLower(p), ".htm") || strings.Contains(p, ".svg"), "never active content: %s", p)
		if !strings.HasSuffix(p, ".item_data.json") {
			assert.Regexp(t, versionPath, p)
			assert.True(t, strings.HasSuffix(p, ".bin"), p)
		}
	}
}

// Mutant: cleanValue keeps control and bidi characters.
func TestTheSidecarHasNoControlOrBidiCharacters(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("a.md", "text/markdown", "a")
	r := seriesRecord{session: "sess\x1b[31m-1", rec: agentUploadRecord{CreatedAt: "2026-11-08T10:00:00Z", Board: "team\u2066x\u2069", Uploader: "agent\u202e\u200b\r\nname"}}
	r.rec.Name = "report\u202egpj.exe\x00\x07\n.md"
	out := be.b.itemData(context.Background(), d, r, 1)
	var m map[string]any
	require.NoError(t, json.Unmarshal(out, &m))
	for _, k := range []string{"name", "agent", "session", "board"} {
		v, _ := m[k].(string)
		for _, c := range v {
			assert.False(t, c < 0x20 || c == 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069), "%s carries %U", k, c)
		}
	}
	assert.Equal(t, "reportgpj.exe.md", m["name"])
	assert.Equal(t, "agentname", m["agent"])
	long := strings.Repeat("é", 200)
	assert.LessOrEqual(t, len(cleanValue(long)), dropboxValueMax, "capped in bytes, on a character boundary")
	assert.True(t, utf8ValidString(cleanValue(long)))
}

func utf8ValidString(s string) bool { return strings.ToValidUTF8(s, "�") == s }

// Mutant: ready lets reconnect or quota_full through.
func TestReadyRefusesOnReconnectAndQuotaFull(t *testing.T) {
	be := newBackupEnv(t)
	ctx := context.Background()
	require.True(t, be.b.ready(ctx))
	for _, st := range []string{store.DropboxStateReconnect, store.DropboxStateQuotaFull} {
		require.NoError(t, be.h.dbx.store.SetState(ctx, st))
		assert.False(t, be.b.ready(ctx), st)
		require.NoError(t, be.h.dbx.store.SetState(ctx, store.DropboxStateConnected))
		assert.True(t, be.b.ready(ctx))
	}
	require.NoError(t, be.h.dbx.store.SetState(ctx, store.DropboxStateReconnect))
	be.put("a.md", "text/markdown", "a")
	be.pass()
	assert.Empty(t, be.dbx.files, "a pass in reconnect sends nothing")
}

// Mutant: the age condition is dropped from the filter.
func TestTheAgeFilterHoldsOldArtifactsWithoutDeletingThem(t *testing.T) {
	be := newBackupEnv(t)
	be.b.maxAge = func() time.Duration { return 24 * time.Hour }
	be.put("a.md", "text/markdown", "a")
	real := be.b.now
	be.b.now = func() time.Time { return real().Add(48 * time.Hour) }
	be.pass()
	assert.Empty(t, be.dbx.files, "older than the limit: not sent")
	assert.Equal(t, 2, be.counts().Pending, "still queued, never deleted")
	be.b.maxAge = func() time.Duration { return 0 }
	be.b.now = func() time.Time { return real().Add(73 * time.Hour) } // the held rows are looked at again a day later
	be.pass()
	assert.Len(t, be.dbx.files, 2, "with no limit they go")
}

// Mutant: a success is marked done without comparing content_hash.
func TestAContentHashMismatchIsNotDone(t *testing.T) {
	be := newBackupEnv(t)
	be.dbx.badHash = true
	be.put("a.md", "text/markdown", "a")
	be.pass()
	c := be.counts()
	assert.Equal(t, 0, c.BackedUp, "Dropbox's hash is not the bytes': not backed up")
	assert.Equal(t, 2, c.Failed)
}

// Mutant: a rate limit waits the usual backoff (or nothing) instead of Retry-After.
func TestRetryAfterIsHonored(t *testing.T) {
	be := newBackupEnv(t)
	t0 := time.Now()
	be.b.now = func() time.Time { return t0 }
	be.dbx.rateLimitOnce = 300 // five minutes: longer than the first backoff's minute
	be.put("a.md", "text/markdown", "a")
	be.pass()
	assert.Empty(t, be.dbx.files)
	assert.Equal(t, dropboxParallel/2, be.b.parallel, "the parallelism is halved")
	be.b.now = func() time.Time { return t0.Add(2 * time.Minute) }
	be.pass()
	assert.Empty(t, be.dbx.files, "not before Retry-After")
	be.b.now = func() time.Time { return t0.Add(301 * time.Second) }
	be.pass()
	assert.Len(t, be.dbx.files, 2, "after it")
}

type logSink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *logSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

// Mutant: a log line carries the token, a path, a digest or a name.
func TestTheLogsCarryCountsAndStateWordsOnly(t *testing.T) {
	sink := &logSink{}
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(old)

	be := newBackupEnv(t)
	d := be.put("secret-plan.md", "text/markdown", "a")
	be.pass() // a success
	be.put("b.md", "text/markdown", "b")
	be.dbx.refreshDead = true
	be.pass() // a revoked sign-in
	require.Len(t, be.dbx.files, 2)
	require.Equal(t, "reconnect", be.status()["state"])

	refresh, _ := be.h.dbx.store.RefreshToken(context.Background())
	sink.mu.Lock()
	text := sink.buf.String()
	sink.mu.Unlock()
	seen := 0
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, "[dropbox]") {
			continue // another test's line
		}
		seen++
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &m))
		for k, v := range m {
			switch k {
			case "time", "level", "msg":
			case "files", "bytes", "state":
				if s, ok := v.(string); ok {
					assert.Regexp(t, `^[a-z_]+$`, s, "a state word")
				}
			default:
				t.Errorf("a dropbox log line carries %q: %s", k, line)
			}
		}
		for _, leak := range []string{"refresh-secret", "a-dbid", "\"a1\"", "Bearer", d, d[:8], "secret-plan", "/v1/", be.h.dbx.dataDir} {
			assert.NotContains(t, line, leak)
		}
		if refresh != "" {
			assert.NotContains(t, line, refresh)
		}
	}
	assert.GreaterOrEqual(t, seen, 2, "the success and the pause are both logged")
}

// Mutant: the pre-commit re-read's error is ignored (round 2, #193763).
func TestAFailingPrivateReReadBeforeTheCommitCommitsNothing(t *testing.T) {
	be := newBackupEnv(t)
	be.put("a.md", "text/markdown", "a")
	be.put("b.md", "text/markdown", "b")
	be.dbx.onStart = func() { be.privErr = errors.New("board unreadable") } // the marks become unreadable while the sessions upload
	be.pass()
	assert.Empty(t, be.dbx.files, "nothing is committed")
	assert.Zero(t, be.dbx.finishCalls, "finish_batch is never called")
	assert.Zero(t, be.counts().BackedUp)
}

// Mutant: the default private reader answers no marks instead of an error.
func TestTheDefaultPrivateReaderFailsClosed(t *testing.T) {
	e := newDropboxEnv(t)
	require.Contains(t, e.signIn(""), "Connected")
	b := e.h.NewDropboxBackup(store.NewDropboxOutbox(e.db)) // never given SetPrivate: the wiring is missing
	b.power = func() (bool, bool) { return false, false }
	b.SetPrivate(nil) // a nil reader keeps the fail-closed default
	_, _, err := storeArtifactVia(e.h.dbx.dataDir, "sess-1", "a.md", "text/markdown", "", "", "", []byte("a"))
	require.NoError(t, err)
	b.Pass(context.Background())
	assert.Empty(t, e.dbx.files, "with no private reader, nothing is sent")
	c, err := b.outbox.Counts(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, c.Pending, "kept queued for when the reader is wired")
}

// Mutant: a delete leaves its queued rows (noteDropboxDelete does nothing).
func TestADeleteCancelsTheQueuedRows(t *testing.T) {
	be := newBackupEnv(t)
	d := be.put("gone.md", "text/markdown", "bye")
	require.Equal(t, 2, be.counts().Pending)
	_, _, _, err := deleteArtifactFiles(be.h.dbx.dataDir, d)
	require.NoError(t, err)
	c := be.counts()
	assert.Zero(t, c.Pending, "the rows are gone before any pass")
	assert.Zero(t, c.Skipped)
}
