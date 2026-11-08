package routes

// Document ids (#14551, Dropbox stage 1; design v30 coral://artifacts/de4860c0…). Every artifact upload is a document with an id of its own: 32 random lowercase hex, the same shape as a
// series id and never a digest, so two uploads of the same bytes are two documents though they share one stored object. A version's document id is its series id, and a series made
// from an unversioned artifact takes that artifact's document id, so a document keeps its id when it gains versions. A received row (a file another Coral or board sent) is a document too.
//
// Existing records get an id from migrateDocIDs, which runs in the background at startup, only ADDS the doc_id field (every other field, unknown ones included, is kept as it is),
// never touches an object or a sidecar, never follows a link, skips a record it cannot read (counted, logged, left as it is), and never blocks or fails startup.

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/secfile"
)

// maxDocIDRecordBytes bounds a record the migration reads: a record is a few hundred bytes.
const maxDocIDRecordBytes = 64 << 10

// receivedRowMu serialises the two writers that rewrite an existing received row: noteAlsoReceived and the migration (so neither loses the other's change). Nothing else takes it.
var receivedRowMu sync.Mutex

// newDocID is a new document id: 128 random bits as 32 lowercase hex.
func newDocID() (string, error) { return newSeriesID() }

// docIDFor is the document id a record being written gets: its series' document id when it is a version, else the id the same session's earlier record of the same bytes had, else a new one.
// "" only when the system has no randomness; the migration fills it later.
func docIDFor(prev string, stamp *seriesStamp) string {
	if stamp != nil && seriesIDRe.MatchString(stamp.DocID) {
		return stamp.DocID
	}
	if seriesIDRe.MatchString(prev) {
		return prev
	}
	id, err := newDocID()
	if err != nil {
		return ""
	}
	return id
}

// docIDOf is a record's document id (never its series id: the two are separate, #14145).
func docIDOf(rec agentUploadRecord) string {
	if seriesIDRe.MatchString(rec.DocID) {
		return rec.DocID
	}
	return ""
}

// docIDMigration is what one pass of migrateDocIDs did.
type docIDMigration struct {
	Stamped int // records that got a document id
	Failed  int // records that could not be read or written: left exactly as they were
}

// docIDMigrationStart starts the migration when the artifact routes are registered; the package's tests run it in place, so no background writer outlives a test's folder.
var docIDMigrationStart = startDocIDMigration

// startDocIDMigration runs migrateDocIDs in the background: startup never waits for it, and a failure is a warning.
func startDocIDMigration(coralDir string) {
	safego.Go("artifact-doc-ids", func() {
		res := migrateDocIDs(coralDir)
		switch {
		case res.Failed > 0:
			slog.Warn("[artifacts] some artifacts did not get a document id; they keep working, and the next start tries again", "stamped", res.Stamped, "failed", res.Failed)
		case res.Stamped > 0:
			slog.Info("[artifacts] gave existing artifacts their document ids", "stamped", res.Stamped)
		}
	})
}

// migrateDocIDs gives every upload record and received row that has no document id one. It is safe to run again: a record with an id is left alone.
func migrateDocIDs(coralDir string) docIDMigration {
	var res docIDMigration
	if coralDir == "" {
		return res
	}
	count := func(stamped bool, err error) {
		switch {
		case err != nil:
			res.Failed++
		case stamped:
			res.Stamped++
		}
	}
	// Every version of a series is one document: first the document id any of a series' records already has, so the others take it.
	seriesDocs := map[string]string{}
	forEachUploadRecord(coralDir, func(_, _ string, rec agentUploadRecord) bool {
		if seriesIDRe.MatchString(rec.SeriesID) && seriesIDRe.MatchString(rec.DocID) && seriesDocs[rec.SeriesID] == "" {
			seriesDocs[rec.SeriesID] = rec.DocID
		}
		return true
	})
	if sessions, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "uploads")); err == nil {
		for _, s := range sessions {
			up := uploadsDir(coralDir, s.Name())
			if up == "" || !s.IsDir() { // a link is not a directory here: never followed
				continue
			}
			forEachRecordFile(up, func(path, digest string) {
				count(stampDocID(path, digest, seriesDocs))
			})
		}
	}
	if boards, err := os.ReadDir(filepath.Join(coralDir, "artifacts", "received")); err == nil {
		for _, b := range boards {
			if !b.IsDir() || !boardDirName.MatchString(b.Name()) {
				continue
			}
			forEachRecordFile(filepath.Join(coralDir, "artifacts", "received", b.Name()), func(path, digest string) {
				receivedRowMu.Lock()
				defer receivedRowMu.Unlock()
				count(stampDocID(path, digest, nil))
			})
		}
	}
	return res
}

// forEachRecordFile calls fn with every <64 hex>.json in dir.
func forEachRecordFile(dir string, fn func(path, digest string)) {
	files, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, f := range files {
		name := f.Name()
		if len(name) != 64+len(".json") || !strings.HasSuffix(name, ".json") {
			continue
		}
		digest := strings.TrimSuffix(name, ".json")
		if objectNameRe.MatchString(digest) {
			fn(filepath.Join(dir, name), digest)
		}
	}
}

// stampDocID adds doc_id to one record file, under its artifact's lock (the lock every writer of an upload record holds). Only the doc_id field is added: the record is read as a map of raw
// values, so every other field, one this build doesn't know included, is written back as it was. An upload record that is a version gets its series' document id (seriesDocs, filled as
// it goes, so every version of a series gets the same one); a received row (seriesDocs nil) gets its own.
func stampDocID(path, digest string, seriesDocs map[string]string) (stamped bool, err error) {
	defer lockArtifact(digest)()
	f, err := secfile.OpenNoFollow(path, os.O_RDONLY, 0) // never through a link
	if err != nil {
		return false, err
	}
	data, err := io.ReadAll(io.LimitReader(f, maxDocIDRecordBytes+1))
	f.Close()
	if err != nil {
		return false, err
	}
	if len(data) > maxDocIDRecordBytes {
		return false, errDocIDRecordTooBig
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil || m == nil {
		return false, errDocIDRecordUnreadable
	}
	var have string
	if raw, ok := m["doc_id"]; ok && json.Unmarshal(raw, &have) == nil && seriesIDRe.MatchString(have) {
		return false, nil
	}
	sid := ""
	if seriesDocs != nil {
		if raw, ok := m["series_id"]; ok {
			_ = json.Unmarshal(raw, &sid)
		}
		if !seriesIDRe.MatchString(sid) {
			sid = ""
		}
	}
	id := ""
	if sid != "" {
		id = seriesDocs[sid]
	}
	if id == "" {
		if id, err = newDocID(); err != nil {
			return false, err
		}
	}
	if sid != "" {
		seriesDocs[sid] = id
	}
	m["doc_id"], _ = json.Marshal(id)
	out, err := json.Marshal(m)
	if err != nil {
		return false, err
	}
	if err := writeFileAtomic(path, out, 0o600); err != nil {
		return false, err
	}
	return true, nil
}

type docIDError string

func (e docIDError) Error() string { return string(e) }

const (
	errDocIDRecordTooBig     docIDError = "record too big"
	errDocIDRecordUnreadable docIDError = "record unreadable"
)
