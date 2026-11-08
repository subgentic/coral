package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14551, Dropbox stage 1: every artifact has a document id (32 hex, random, never a digest) from its first upload; a version's document id is its series id; existing artifacts get one by a
// migration that only adds the field.

func docIDOfRecord(t *testing.T, coralDir, session, digest string) string {
	t.Helper()
	rec, ok := readUploadRecord(coralDir, session, digest)
	require.True(t, ok, "the upload record of %s in %s", digest, session)
	return rec.DocID
}

func TestAnUploadGetsADocumentID(t *testing.T) {
	rig, _ := ownerRig(t)
	d := rig.uploadText("a1", "notes.txt", "some notes")
	id := docIDOfRecord(t, rig.coralDir, "a1", d)
	assert.Regexp(t, `^[0-9a-f]{32}$`, id, "a random 32-hex document id")
	assert.NotEqual(t, d[:32], id, "never derived from the digest")
}

func TestTheSameBytesUploadedTwiceAreTwoDocuments(t *testing.T) {
	rig, _ := ownerRig(t)
	d1 := rig.uploadText("a1", "same.txt", "identical bytes")
	d2 := rig.uploadText("b1", "same.txt", "identical bytes")
	require.Equal(t, d1, d2, "one stored object")
	a, b := docIDOfRecord(t, rig.coralDir, "a1", d1), docIDOfRecord(t, rig.coralDir, "b1", d2)
	assert.Regexp(t, `^[0-9a-f]{32}$`, a)
	assert.Regexp(t, `^[0-9a-f]{32}$`, b)
	assert.NotEqual(t, a, b, "two uploads of the same bytes are two documents")
}

func TestAReuploadBySameSessionKeepsItsDocumentID(t *testing.T) {
	rig, _ := ownerRig(t)
	d := rig.uploadText("a1", "again.txt", "upload me twice")
	first := docIDOfRecord(t, rig.coralDir, "a1", d)
	require.NotEmpty(t, first)
	rig.uploadText("a1", "again.txt", "upload me twice")
	assert.Equal(t, first, docIDOfRecord(t, rig.coralDir, "a1", d), "a re-upload never changes the document id")
}

func TestASeriesIsTheDocumentItsFirstVersionAlreadyWas(t *testing.T) {
	rig, _ := ownerRig(t)
	v1 := rig.uploadText("a1", "plan.txt", "plan, first draft")
	before := docIDOfRecord(t, rig.coralDir, "a1", v1)
	require.Regexp(t, `^[0-9a-f]{32}$`, before)
	code, out := rig.uploadVersion("a1", "plan.txt", "plan, second draft", "coral://artifacts/"+v1)
	require.Equal(t, http.StatusCreated, code, out)
	sid, _ := out["series_id"].(string)
	assert.NotEqual(t, before, sid, "the series id stays derived (#14145); the document id is a separate field")
	assert.Equal(t, before, docIDOfRecord(t, rig.coralDir, "a1", v1), "version 1 keeps its document id")
	v2 := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	assert.Equal(t, before, docIDOfRecord(t, rig.coralDir, "a1", v2), "every version carries version 1's document id")
	code, out = rig.uploadVersion("a2", "plan.txt", "plan, third draft", "coral://artifacts/"+v2)
	require.Equal(t, http.StatusCreated, code, out)
	v3 := strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	assert.Equal(t, before, docIDOfRecord(t, rig.coralDir, "a2", v3), "a later version, by another agent, is the same document")
}

// A store shaped by the previous release: upload records with no doc_id (one a version of a series, one with a field this build doesn't know), a received row, a damaged record, and
// objects and sidecars that must stay byte-identical.
func previousReleaseStore(t *testing.T) (coralDir string, recs map[string]string) {
	t.Helper()
	coralDir = t.TempDir()
	objects := filepath.Join(coralDir, "artifacts", "objects")
	require.NoError(t, os.MkdirAll(objects, 0o700))
	digest := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	put := func(rel, body string) {
		p := filepath.Join(coralDir, filepath.FromSlash(rel))
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o700))
		require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	}
	plain, v1, v2, odd := digest("plain"), digest("v1"), digest("v2"), digest("odd")
	for _, d := range []string{plain, v1, v2, odd} {
		put("artifacts/objects/"+d, "bytes of "+d)
		put("artifacts/objects/"+d+".json", `{"name":"f.txt","media_type":"text/plain","size":3,"digest":"sha256:`+d+`"}`)
	}
	sid := "0123456789abcdef0123456789abcdef"
	recs = map[string]string{
		"plain": "artifacts/uploads/s1/" + plain + ".json",
		"v1":    "artifacts/uploads/s1/" + v1 + ".json",
		"v2":    "artifacts/uploads/s2/" + v2 + ".json",
		"odd":   "artifacts/uploads/s2/" + odd + ".json",
		"bad":   "artifacts/uploads/s3/" + digest("bad") + ".json",
		"recv":  "artifacts/received/" + strings.Repeat("ab", 16) + "/" + plain + ".json",
	}
	put(recs["plain"], `{"name":"a.txt","media_type":"text/plain","size":3,"digest":"sha256:`+plain+`","created_at":"2026-10-01T00:00:00Z","board":"b","uploader":"x"}`)
	put(recs["v1"], `{"name":"p.txt","media_type":"text/plain","size":3,"digest":"sha256:`+v1+`","created_at":"2026-10-01T00:00:00Z","series_id":"`+sid+`","version":1}`)
	put(recs["v2"], `{"name":"p.txt","media_type":"text/plain","size":3,"digest":"sha256:`+v2+`","created_at":"2026-10-02T00:00:00Z","series_id":"`+sid+`","version":2,"previous":"`+v1+`"}`)
	put(recs["odd"], `{"name":"o.txt","media_type":"text/plain","size":3,"digest":"sha256:`+odd+`","created_at":"2026-10-03T00:00:00Z","future_field":{"kept":true}}`)
	put(recs["bad"], `{"name": this is not json`)
	put(recs["recv"], `{"id":"`+plain+`","name":"a.txt","size":3,"board":"b","other_board":"c","server":"local","by":"y","message_id":7,"at":"2026-10-04T00:00:00Z"}`)
	return coralDir, recs
}

func readJSONMap(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(b, &m))
	return m
}

func snapshotObjects(t *testing.T, coralDir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	root := filepath.Join(coralDir, "artifacts", "objects")
	require.NoError(t, filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		out[p] = string(b)
		return err
	}))
	return out
}

func TestTheMigrationAddsDocumentIDsToAPreviousReleaseStoreAndChangesNothingElse(t *testing.T) {
	coralDir, recs := previousReleaseStore(t)
	objectsBefore := snapshotObjects(t, coralDir)
	before := map[string]map[string]any{}
	for k, rel := range recs {
		if k != "bad" {
			before[k] = readJSONMap(t, filepath.Join(coralDir, rel))
		}
	}
	badBefore, err := os.ReadFile(filepath.Join(coralDir, recs["bad"]))
	require.NoError(t, err)

	res := migrateDocIDs(coralDir)
	assert.Equal(t, 5, res.Stamped, "four upload records and one received row")
	assert.Equal(t, 1, res.Failed, "the damaged record is counted, not fixed and not removed")

	after := map[string]map[string]any{}
	for k := range before {
		after[k] = readJSONMap(t, filepath.Join(coralDir, recs[k]))
		id, _ := after[k]["doc_id"].(string)
		assert.Regexp(t, `^[0-9a-f]{32}$`, id, k)
		got := map[string]any{}
		for f, v := range after[k] {
			if f != "doc_id" {
				got[f] = v
			}
		}
		assert.Equal(t, before[k], got, "%s: only doc_id was added; every other field, unknown ones included, is unchanged", k)
	}
	sid := before["v1"]["series_id"]
	assert.Equal(t, after["v1"]["doc_id"], after["v2"]["doc_id"], "every version of a series gets one document id")
	assert.NotEqual(t, sid, after["v1"]["doc_id"], "the document id is not the series id (#14145)")
	assert.NotEqual(t, after["plain"]["doc_id"], after["recv"]["doc_id"], "a received row is its own document")
	badAfter, err := os.ReadFile(filepath.Join(coralDir, recs["bad"]))
	require.NoError(t, err, "a damaged record is never removed")
	assert.Equal(t, badBefore, badAfter, "nor rewritten")
	assert.Equal(t, objectsBefore, snapshotObjects(t, coralDir), "objects and sidecars are untouched")

	again := migrateDocIDs(coralDir)
	assert.Equal(t, 0, again.Stamped, "a second pass stamps nothing")
	for k := range before {
		assert.Equal(t, after[k]["doc_id"], readJSONMap(t, filepath.Join(coralDir, recs[k]))["doc_id"], "%s keeps its id", k)
	}
}

func TestTheMigrationOnAStoreWithNoArtifactsDoesNothingAndNeverFails(t *testing.T) {
	res := migrateDocIDs(t.TempDir())
	assert.Zero(t, res.Stamped)
	assert.Zero(t, res.Failed)
}

func TestTheMigrationNeverFollowsALinkedRecord(t *testing.T) {
	coralDir, _ := previousReleaseStore(t)
	outside := filepath.Join(t.TempDir(), "outside.json")
	body := `{"name":"x","digest":"sha256:` + strings.Repeat("c", 64) + `"}`
	require.NoError(t, os.WriteFile(outside, []byte(body), 0o600))
	link := filepath.Join(coralDir, "artifacts", "uploads", "s1", strings.Repeat("c", 64)+".json")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("no symlinks here")
	}
	migrateDocIDs(coralDir)
	b, err := os.ReadFile(outside)
	require.NoError(t, err)
	assert.Equal(t, body, string(b), "a file outside the store, reached through a link, is never written")
}
